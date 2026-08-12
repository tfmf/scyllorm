import { InvalidQueryError } from '../errors';
import { BindableValue, RawQueryParams } from './query-utils';

/** A raw query with its `:name` placeholders replaced by positional ones. */
export interface BoundQuery {
    /** The CQL to send, with `?` in place of every `:name`. */
    query: string;
    /** The values to bind, in the order their placeholders appear. */
    params: BindableValue[];
}

/** The first character of a `:name`. Digits are excluded so `{'a':1}` is left alone. */
const NAME_START = /[A-Za-z_]/;

/** Every subsequent character of a `:name`. */
const NAME_PART = /[A-Za-z0-9_]/;

/**
 * CQL's reserved literals. No parameter can legitimately be named one of these, so a
 * colon immediately followed by one — as in the map literal `{'a':true}` — is the
 * literal, not a placeholder.
 */
const RESERVED_LITERALS = new Set(['true', 'false', 'null']);

/**
 * Copy a region the scanner must not look inside, and report where it ends.
 *
 * CQL closes a quoted region with the same character that opened it, and doubles
 * it to escape — `'it''s'` is one literal, not two.
 *
 * @param {string} query The query being scanned.
 * @param {number} start The index of the opening quote.
 * @returns {number} The index just past the closing quote, or the end of the query if it is unterminated.
 */
function endOfQuoted(query: string, start: number): number {
    const quote = query[start];
    let index = start + 1;

    while (index < query.length) {
        if (query[index] === quote) {
            // A doubled quote is an escaped one, so the region continues past it
            if (query[index + 1] === quote) {
                index += 2;
                continue;
            }

            return index + 1;
        }

        index++;
    }

    // Unterminated: this is the caller's CQL to get wrong, and the server says so better than we can
    return query.length;
}

/**
 * Copy a region that runs to a fixed terminator, and report where it ends.
 *
 * @param {string} query The query being scanned.
 * @param {number} start The index the region opens at.
 * @param {string} terminator The sequence that closes it.
 * @returns {number} The index just past the terminator, or the end of the query if it never appears.
 */
function endOfDelimited(query: string, start: number, terminator: string): number {
    const found = query.indexOf(terminator, start + terminator.length);

    return found === -1 ? query.length : found + terminator.length;
}

/**
 * Replace every `:name` in a raw query with a positional placeholder.
 *
 * Scanned rather than matched with a regular expression, because `:name` is only
 * a parameter in code: a bare `/:(\w+)/g` also rewrites the middle of the time
 * literal `'12:30:00'` and the `:ticket` in a `-- comment`. String literals,
 * quoted identifiers, dollar-quoted strings and all three comment forms are
 * copied through untouched.
 *
 * Values are read as own properties only, so a polluted `Object.prototype` cannot
 * supply a parameter the caller never passed.
 *
 * @param {string} query The raw CQL, with `:name` placeholders for values.
 * @param {RawQueryParams} params A value for every `:name` in the query.
 * @param {string} entity The name of the entity class, for the error message.
 * @returns {BoundQuery} The query to send and the values to bind.
 * @throws {InvalidQueryError} If the query names a parameter that was not supplied.
 */
export function bindNamedParameters(query: string, params: RawQueryParams, entity: string): BoundQuery {
    const parts: string[] = [];
    const values: BindableValue[] = [];
    let index = 0;
    let copiedFrom = 0;

    while (index < query.length) {
        const char = query[index];
        const next = query[index + 1];

        if (char === "'" || char === '"') {
            index = endOfQuoted(query, index);
        } else if (char === '$' && next === '$') {
            index = endOfDelimited(query, index, '$$');
        } else if ((char === '-' && next === '-') || (char === '/' && next === '/')) {
            index = endOfDelimited(query, index, '\n');
        } else if (char === '/' && next === '*') {
            index = endOfDelimited(query, index, '*/');
        } else if (char === ':' && next !== undefined && NAME_START.test(next)) {
            let end = index + 2;

            while (end < query.length && NAME_PART.test(query[end])) {
                end++;
            }

            const name = query.slice(index + 1, end);

            if (RESERVED_LITERALS.has(name)) {
                index = end;
            } else if (!Object.prototype.hasOwnProperty.call(params, name)) {
                // Own properties only: an inherited key is not a value the caller passed
                throw InvalidQueryError.missingParameter(name, entity);
            } else {
                parts.push(query.slice(copiedFrom, index), '?');
                values.push(params[name]);

                index = end;
                copiedFrom = end;
            }
        } else {
            index++;
        }
    }

    parts.push(query.slice(copiedFrom));

    return { query: parts.join(''), params: values };
}
