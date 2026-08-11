import { describe, it, expect } from 'vitest';
import { ScyllormError, UnknownColumnError, InvalidQueryError } from '../errors';

describe('Errors', () => {
    describe('ScyllormError', () => {
        it('should make every error catchable as an Error and as a ScyllormError', () => {
            const unknownColumn = new UnknownColumnError({ column: 'x', entity: 'Employee', knownColumns: ['id'] });
            const invalidQuery = new InvalidQueryError('nope');

            for (const error of [unknownColumn, invalidQuery]) {
                expect(error).toBeInstanceOf(Error);
                expect(error).toBeInstanceOf(ScyllormError);
            }
        });

        it('should not confuse the two concrete errors with each other', () => {
            expect(new InvalidQueryError('nope')).not.toBeInstanceOf(UnknownColumnError);
        });

        it('should carry a stable code and name', () => {
            const unknownColumn = new UnknownColumnError({ column: 'x', entity: 'Employee', knownColumns: ['id'] });
            const invalidQuery = new InvalidQueryError('nope');

            expect(unknownColumn.code).toBe('SCYLLORM_UNKNOWN_COLUMN');
            expect(unknownColumn.name).toBe('UnknownColumnError');
            expect(invalidQuery.code).toBe('SCYLLORM_INVALID_QUERY');
            expect(invalidQuery.name).toBe('InvalidQueryError');
        });

        it('should produce a stack trace', () => {
            expect(new InvalidQueryError('nope').stack).toContain('errors.test.ts');
        });
    });

    describe('UnknownColumnError', () => {
        const details = {
            column: 'sortBy',
            entity: 'Employee',
            table: 'employees',
            knownColumns: ['id', 'first_name', 'last_name', 'age', 'city'],
        };

        it('should expose the rejected column, the entity and the table', () => {
            const error = new UnknownColumnError(details);

            expect(error.column).toBe('sortBy');
            expect(error.entity).toBe('Employee');
            expect(error.table).toBe('employees');
            expect(error.knownColumns).toEqual(['id', 'first_name', 'last_name', 'age', 'city']);
        });

        it('should copy the known columns instead of aliasing the caller array', () => {
            const knownColumns = ['id', 'name'];
            const error = new UnknownColumnError({ column: 'x', entity: 'Employee', knownColumns });

            knownColumns.push('injected');

            expect(error.knownColumns).toEqual(['id', 'name']);
        });

        it('should name the column, the entity and the table in the message', () => {
            const message = new UnknownColumnError(details).message;

            expect(message).toContain('Unknown column "sortBy"');
            expect(message).toContain('entity Employee');
            expect(message).toContain('(table "employees")');
            expect(message).toContain('Known columns: id, first_name, last_name, age, city.');
            expect(message).toContain('@Column()');
        });

        it('should omit the table when the entity does not declare one', () => {
            const message = new UnknownColumnError({ column: 'x', entity: 'Employee', knownColumns: ['id'] }).message;

            expect(message).toContain('entity Employee.');
            expect(message).not.toContain('table');
        });

        it('should say so when the entity declares no columns at all', () => {
            const message = new UnknownColumnError({ column: 'x', entity: 'Employee', knownColumns: [] }).message;

            expect(message).toContain('the entity declares no columns');
        });

        it('should cap the listed columns', () => {
            const knownColumns = Array.from({ length: 12 }, (_, index) => `col_${index}`);
            const message = new UnknownColumnError({ column: 'x', entity: 'Employee', knownColumns }).message;

            expect(message).toContain('col_7');
            expect(message).not.toContain('col_8');
            expect(message).toContain('…and 4 more');
        });

        describe('suggestions', () => {
            const suggestionFor = (column: string, knownColumns = details.knownColumns) =>
                new UnknownColumnError({ column, entity: 'Employee', knownColumns }).message;

            it('should suggest the column that differs only by case', () => {
                expect(suggestionFor('FIRST_NAME')).toContain('Did you mean "first_name"?');
            });

            it('should suggest the closest column for a near typo', () => {
                expect(suggestionFor('frist_name')).toContain('Did you mean "first_name"?');
            });

            it('should not suggest anything for an unrelated name', () => {
                expect(suggestionFor('salary_in_euros')).not.toContain('Did you mean');
            });

            it('should not guess at very short names, where everything is a near match', () => {
                expect(suggestionFor('ix', ['id'])).not.toContain('Did you mean');
            });

            it('should not try to fuzzy-match an injection payload', () => {
                expect(suggestionFor('id = 1 ALLOW FILTERING; DROP TABLE employees; --')).not.toContain('Did you mean');
            });
        });

        describe('untrusted input in the message', () => {
            it('should escape control characters rather than forging a log line', () => {
                const message = new UnknownColumnError({
                    column: 'na\nme',
                    entity: 'Employee',
                    knownColumns: ['id'],
                }).message;

                expect(message).toContain('"na\\nme"');
                expect(message).not.toContain('\n');
            });

            it('should escape embedded quotes', () => {
                const message = new UnknownColumnError({
                    column: 'na"me',
                    entity: 'Employee',
                    knownColumns: ['id'],
                }).message;

                expect(message).toContain('na\\"me');
            });

            it('should truncate a large payload while keeping the full value on the error', () => {
                const column = 'a'.repeat(8192);
                const error = new UnknownColumnError({ column, entity: 'Employee', knownColumns: ['id'] });

                expect(error.column).toBe(column);
                expect(error.message).toContain(`${'a'.repeat(64)}…`);
                expect(error.message.length).toBeLessThan(300);
            });
        });
    });

    describe('InvalidQueryError', () => {
        it('should pass the message through unchanged', () => {
            expect(new InvalidQueryError('Sort direction must be ASC or DESC.').message).toBe(
                'Sort direction must be ASC or DESC.'
            );
        });

        describe('invalidIdentifier', () => {
            it('should name the identifier, the entity and the escape hatch', () => {
                const error = InvalidQueryError.invalidIdentifier('token(id)', 'Employee');

                expect(error).toBeInstanceOf(InvalidQueryError);
                expect(error.code).toBe('SCYLLORM_INVALID_QUERY');
                expect(error.message).toContain('Invalid column identifier "token(id)"');
                expect(error.message).toContain('entity Employee');
                expect(error.message).toContain('runRawQuery()');
            });

            it('should escape and truncate the rejected identifier', () => {
                const error = InvalidQueryError.invalidIdentifier(
                    `x'; DROP TABLE employees; --\n${'b'.repeat(100)}`,
                    'E'
                );

                expect(error.message).not.toContain('\n');
                expect(error.message).toContain('…');
                expect(error.message.length).toBeLessThan(300);
            });
        });
    });
});
