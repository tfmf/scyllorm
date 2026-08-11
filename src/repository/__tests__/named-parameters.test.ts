import { describe, it, expect } from 'vitest';
import { bindNamedParameters } from '../named-parameters';
import { InvalidQueryError } from '../../errors';

/* eslint-disable @typescript-eslint/no-explicit-any */

const bind = (query: string, params: Record<string, unknown> = {}) => bindNamedParameters(query, params, 'Item');

describe('bindNamedParameters', () => {
    describe('substitution', () => {
        it('should replace a placeholder with a positional one', () => {
            expect(bind('SELECT * FROM items WHERE id = :id', { id: 'abc' })).toEqual({
                query: 'SELECT * FROM items WHERE id = ?',
                params: ['abc'],
            });
        });

        it('should bind in the order the placeholders appear', () => {
            const { params } = bind('WHERE b = :b AND a = :a', { a: 1, b: 2 });

            expect(params).toEqual([2, 1]);
        });

        it('should bind a repeated placeholder once per occurrence', () => {
            const { query, params } = bind('WHERE a > :n AND a < :n', { n: 3 });

            expect(query).toBe('WHERE a > ? AND a < ?');
            expect(params).toEqual([3, 3]);
        });

        it('should accept a leading underscore and digits after the first character', () => {
            const { query, params } = bind('WHERE a = :_x1', { _x1: 'v' });

            expect(query).toBe('WHERE a = ?');
            expect(params).toEqual(['v']);
        });

        it('should stop the name at the first character that cannot be part of it', () => {
            const { query, params } = bind('WHERE a = :id,', { id: 'v' });

            expect(query).toBe('WHERE a = ?,');
            expect(params).toEqual(['v']);
        });

        it('should leave a query with no placeholders untouched', () => {
            expect(bind('SELECT * FROM items')).toEqual({ query: 'SELECT * FROM items', params: [] });
        });

        it('should keep the placeholder and parameter counts equal', () => {
            const { query, params } = bind("WHERE a = :a AND b = ':b' AND c = :c -- :d", { a: 1, c: 3 });

            expect(query.split('?').length - 1).toBe(params.length);
        });
    });

    describe('regions the scanner must not look inside', () => {
        it('should not rewrite a colon inside a string literal', () => {
            const { query, params } = bind("WHERE t = '12:30:00' AND id = :id", { id: 'abc' });

            expect(query).toBe("WHERE t = '12:30:00' AND id = ?");
            expect(params).toEqual(['abc']);
        });

        it('should treat a doubled quote as an escape rather than the end of the literal', () => {
            const { query } = bind("WHERE a = 'it''s :not_a_param' AND b = :b", { b: 1 });

            expect(query).toBe("WHERE a = 'it''s :not_a_param' AND b = ?");
        });

        it('should not rewrite a colon inside a quoted identifier', () => {
            const { query } = bind('WHERE "odd:name" = :v', { v: 1 });

            expect(query).toBe('WHERE "odd:name" = ?');
        });

        it('should not rewrite a colon inside a dollar-quoted string', () => {
            const { query } = bind("WHERE a = $$it's :verbatim$$ AND b = :b", { b: 1 });

            expect(query).toBe("WHERE a = $$it's :verbatim$$ AND b = ?");
        });

        it('should not rewrite a colon inside a -- comment', () => {
            const { query } = bind('SELECT * FROM items -- see :ticket\nWHERE id = :id', { id: 'abc' });

            expect(query).toBe('SELECT * FROM items -- see :ticket\nWHERE id = ?');
        });

        it('should not rewrite a colon inside a // comment', () => {
            const { query } = bind('SELECT * FROM items // see :ticket\nWHERE id = :id', { id: 'abc' });

            expect(query).toBe('SELECT * FROM items // see :ticket\nWHERE id = ?');
        });

        it('should not rewrite a colon inside a block comment', () => {
            const { query } = bind('SELECT /* :nope */ * FROM items WHERE id = :id', { id: 'abc' });

            expect(query).toBe('SELECT /* :nope */ * FROM items WHERE id = ?');
        });

        it('should resume substituting after a region closes', () => {
            const { params } = bind("WHERE a = ':x' AND b = :b /* :y */ AND c = :c", { b: 1, c: 2 });

            expect(params).toEqual([1, 2]);
        });

        it('should copy an unterminated literal through rather than inventing a parse error', () => {
            const { query, params } = bind("WHERE a = 'unterminated :id", { id: 'abc' });

            expect(query).toBe("WHERE a = 'unterminated :id");
            expect(params).toEqual([]);
        });
    });

    describe('colons that are not placeholders', () => {
        it('should leave a colon followed by a digit alone, as in a map literal', () => {
            const { query, params } = bind("SET m = {'a':1} WHERE id = :id", { id: 'abc' });

            expect(query).toBe("SET m = {'a':1} WHERE id = ?");
            expect(params).toEqual(['abc']);
        });

        it('should leave a trailing colon alone', () => {
            expect(bind('WHERE a = :').query).toBe('WHERE a = :');
        });

        it('should leave a colon followed by a space alone', () => {
            expect(bind('SET m = {1: 2}').query).toBe('SET m = {1: 2}');
        });
    });

    describe('missing parameters', () => {
        it('should throw an InvalidQueryError naming the parameter', () => {
            expect(() => bind('WHERE id = :id')).toThrow(InvalidQueryError);
            expect(() => bind('WHERE id = :id')).toThrow(/"id"/);
        });

        it('should reject a key inherited from the prototype', () => {
            (Object.prototype as any).id = 'polluted';

            try {
                expect(() => bind('WHERE id = :id')).toThrow(InvalidQueryError);
            } finally {
                delete (Object.prototype as any).id;
            }
        });

        it('should accept an own key whose value is undefined', () => {
            const { query, params } = bind('WHERE id = :id', { id: undefined });

            expect(query).toBe('WHERE id = ?');
            expect(params).toEqual([undefined]);
        });
    });

    describe('values', () => {
        it('should pass a value through without inspecting it', () => {
            const date = new Date('2020-01-01T00:00:00Z');
            const { params } = bind('WHERE at = :at AND blob = :blob', { at: date, blob: Buffer.from('x') });

            expect(params[0]).toBe(date);
            expect(params[1]).toEqual(Buffer.from('x'));
        });

        it('should ignore params the query never references', () => {
            expect(bind('WHERE a = :a', { a: 1, unused: 2 }).params).toEqual([1]);
        });
    });
});
