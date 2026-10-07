import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BaseModel, Column, DataSource, Entity, PrimaryKeyColumn, Repository, consistencies } from '../src';

@Entity('scyllorm_consistency.notes')
class Note extends BaseModel {
    @PrimaryKeyColumn('INT', { partitionKey: true })
    id: number;

    @Column('TEXT')
    body: string;
}

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('per-query consistency against a live ScyllaDB', () => {
    let dataSource: DataSource;
    let notes: Repository<Note>;

    beforeAll(async () => {
        dataSource = new DataSource({ contactPoints: ['127.0.0.1'], localDataCenter: 'datacenter1', logger: silent });
        await dataSource.initialize();

        // RF 1: a level needing more replicas than exist is refused by the server,
        // which is how these tests prove the level was actually sent
        await dataSource.executeQuery(
            'CREATE KEYSPACE IF NOT EXISTS scyllorm_consistency ' +
                "WITH replication = { 'class': 'SimpleStrategy', 'replication_factor': 1 } " +
                "AND tablets = { 'enabled': false }",
            [],
            { prepare: false }
        );
        await dataSource.synchronize([Note]);

        notes = dataSource.getRepository(Note);
    });

    afterAll(async () => {
        if (dataSource) {
            try {
                await dataSource.executeQuery('DROP KEYSPACE IF EXISTS scyllorm_consistency', [], { prepare: false });
            } finally {
                await dataSource.shutdown();
            }
        }
    });

    it('writes and reads at a level the cluster can satisfy', async () => {
        const note = notes.create({ id: 1, body: 'hello' });

        await notes.save(note, { consistency: consistencies.localQuorum });
        const found = await notes.find({ where: { id: 1 }, consistency: consistencies.localOne });

        expect(found.map((row) => row.body)).toEqual(['hello']);
    });

    it('sends the level to the server, which refuses one it cannot satisfy', async () => {
        await expect(notes.find({ where: { id: 1 }, consistency: consistencies.three })).rejects.toThrow(
            /at consistency THREE/
        );
        await expect(notes.delete({ id: 1 }, { consistency: consistencies.three })).rejects.toThrow(
            /at consistency THREE/
        );
    });
});
