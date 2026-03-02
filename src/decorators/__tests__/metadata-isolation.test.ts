import { describe, it, expect } from 'vitest';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../Entity';
import { Column } from '../Column';
import { PrimaryKeyColumn } from '../PrimaryKey';
import { Index } from '../IndexDecorator';

// Define two entity classes to test metadata isolation

@Entity('users')
@Index('idx_users_email', 'email')
class User extends BaseModel {
    @PrimaryKeyColumn('UUID')
    id: string;

    @Column('TEXT')
    name: string;

    @Column('TEXT')
    email: string;
}

@Entity('posts')
@Index('idx_posts_title', 'title')
class Post extends BaseModel {
    @PrimaryKeyColumn('UUID')
    post_id: string;

    @Column('TEXT')
    title: string;

    @Column('INT')
    views: number;
}

describe('Decorator Metadata Isolation', () => {
    it('should give each entity its own columns array', () => {
        const userColumns = User.columns!.map((c) => c.name);
        const postColumns = Post.columns!.map((c) => c.name);

        expect(userColumns).toContain('id');
        expect(userColumns).toContain('name');
        expect(userColumns).toContain('email');
        expect(userColumns).not.toContain('post_id');
        expect(userColumns).not.toContain('title');
        expect(userColumns).not.toContain('views');

        expect(postColumns).toContain('post_id');
        expect(postColumns).toContain('title');
        expect(postColumns).toContain('views');
        expect(postColumns).not.toContain('id');
        expect(postColumns).not.toContain('name');
        expect(postColumns).not.toContain('email');
    });

    it('should give each entity its own primaryKeys array', () => {
        const userPKs = User.primaryKeys!.map((pk) => pk.name);
        const postPKs = Post.primaryKeys!.map((pk) => pk.name);

        expect(userPKs).toEqual(['id']);
        expect(postPKs).toEqual(['post_id']);
    });

    it('should give each entity its own indexes array', () => {
        const userIndexes = User.indexes!.map((idx) => idx.name);
        const postIndexes = Post.indexes!.map((idx) => idx.name);

        expect(userIndexes).toEqual(['idx_users_email']);
        expect(postIndexes).toEqual(['idx_posts_title']);
    });

    it('should give each entity its own table name', () => {
        expect(User.getTableName()).toBe('users');
        expect(Post.getTableName()).toBe('posts');
    });

    it('should not share column arrays by reference', () => {
        expect(User.columns).not.toBe(Post.columns);
        expect(User.primaryKeys).not.toBe(Post.primaryKeys);
        expect(User.indexes).not.toBe(Post.indexes);
    });

    it('should not mutate BaseModel static properties', () => {
        // BaseModel should not have any columns/primaryKeys/indexes of its own
        expect(BaseModel.hasOwnProperty('columns')).toBe(false);
        expect(BaseModel.hasOwnProperty('primaryKeys')).toBe(false);
    });
});
