import { ColumnType } from '../decorators/Column';
import { ColumnValidationError } from '../errors';

/**
 * Write-time value validation: one predicate per CQL column type.
 *
 * The driver accepts several JavaScript shapes per CQL type — a BIGINT binds
 * from a number, a bigint, a digit string or a driver Long — so every predicate
 * here is deliberately permissive: it rejects only values no accepted shape of
 * the type could carry. The point is to fail locally, naming the column and the
 * entity, instead of a round trip away with the driver's encoding error.
 */

/** The canonical textual form of a UUID: five dash-separated hex groups. */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A whole number in decimal text, as the driver parses for BIGINT and VARINT. */
const DIGIT_STRING = /^-?\d+$/;

/** A decimal number in text, optionally with a fraction and an exponent. */
const DECIMAL_STRING = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/** A predicate for one CQL type, and how to describe it when it rejects. */
interface TypeRule {
    /** What the type accepts, phrased for the error message. */
    expected: string;
    /** Whether the value is a shape the driver can encode for the type. */
    accepts: (value: unknown) => boolean;
}

/**
 * Builds the rule for a fixed-width CQL integer. The bounds are asymmetric —
 * two's complement carries one more negative value than positive.
 *
 * @param {string} name The CQL type name, for the error message.
 * @param {number} min The smallest value the type carries.
 * @param {number} max The largest value the type carries.
 * @returns {TypeRule} The rule to register.
 */
function boundedInteger(name: string, min: number, max: number): TypeRule {
    return {
        expected: `an integer between ${min} and ${max} for ${name}`,
        accepts: (value) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max,
    };
}

/** ASCII, TEXT and VARCHAR all bind from a string and nothing else. */
const text: TypeRule = {
    expected: 'a string',
    accepts: (value) => typeof value === 'string',
};

/** BIGINT, VARINT and COUNTER: integer number, bigint, digit string or driver Long/Integer. */
const bigInteger: TypeRule = {
    expected: 'an integer number, a bigint, a digit string or a driver Long/Integer',
    accepts: (value) =>
        (typeof value === 'number' && Number.isInteger(value)) ||
        typeof value === 'bigint' ||
        (typeof value === 'string' && DIGIT_STRING.test(value)) ||
        typeof value === 'object',
};

/** FLOAT and DOUBLE bind from any number, including NaN and the infinities. */
const floating: TypeRule = {
    expected: 'a number',
    accepts: (value) => typeof value === 'number',
};

/** DATE and TIME: a string, a Date, or a driver LocalDate/LocalTime object. */
const dateOrTime: TypeRule = {
    expected: 'a string, a Date or a driver LocalDate/LocalTime',
    accepts: (value) => typeof value === 'string' || typeof value === 'object',
};

/** UUID and TIMEUUID: the canonical textual form, or a driver Uuid object. */
const uuid: TypeRule = {
    expected: 'a canonical UUID string or a driver Uuid',
    accepts: (value) => (typeof value === 'string' && UUID_PATTERN.test(value)) || typeof value === 'object',
};

/** LIST and SET bind from an Array or a Set. */
const listOrSet: TypeRule = {
    expected: 'an Array or a Set',
    accepts: (value) => Array.isArray(value) || value instanceof Set,
};

/**
 * The rule for every CQL type this ORM declares.
 *
 * Null and undefined never reach these predicates — null is a tombstone and
 * undefined is "unset", both handled by the query builders — so a predicate
 * checking `typeof value === 'object'` accepts driver objects, not null.
 */
const RULES: Record<ColumnType, TypeRule> = {
    ASCII: text,
    TEXT: text,
    VARCHAR: text,
    BOOLEAN: {
        expected: 'a boolean',
        accepts: (value) => typeof value === 'boolean',
    },
    INT: boundedInteger('INT', -2147483648, 2147483647),
    SMALLINT: boundedInteger('SMALLINT', -32768, 32767),
    TINYINT: boundedInteger('TINYINT', -128, 127),
    BIGINT: bigInteger,
    VARINT: bigInteger,
    COUNTER: bigInteger,
    FLOAT: floating,
    DOUBLE: floating,
    DECIMAL: {
        expected: 'a number, a numeric string or a driver BigDecimal',
        accepts: (value) =>
            typeof value === 'number' ||
            (typeof value === 'string' && DECIMAL_STRING.test(value)) ||
            typeof value === 'object',
    },
    TIMESTAMP: {
        expected: 'a Date, a finite number, a string or a driver Long',
        accepts: (value) =>
            value instanceof Date ||
            (typeof value === 'number' && Number.isFinite(value)) ||
            typeof value === 'string' ||
            (typeof value === 'object' && value !== null),
    },
    DATE: dateOrTime,
    TIME: dateOrTime,
    UUID: uuid,
    TIMEUUID: uuid,
    INET: {
        expected: 'an address string or a driver InetAddress',
        accepts: (value) => typeof value === 'string' || typeof value === 'object',
    },
    BLOB: {
        expected: 'a Buffer or an ArrayBufferView',
        accepts: (value) => ArrayBuffer.isView(value),
    },
    DURATION: {
        expected: 'a duration string or a driver Duration',
        accepts: (value) => typeof value === 'string' || typeof value === 'object',
    },
    LIST: listOrSet,
    SET: listOrSet,
    MAP: {
        expected: 'a Map or a plain object',
        accepts: (value) => value instanceof Map || (typeof value === 'object' && !Array.isArray(value)),
    },
    TUPLE: {
        expected: 'an Array or a driver Tuple',
        accepts: (value) => typeof value === 'object',
    },
    // A frozen type's inner shape is not modelled, so nothing can be rejected locally
    FROZEN: {
        expected: 'any value',
        accepts: () => true,
    },
};

/**
 * Validate a value about to be written to a column, or throw.
 *
 * Null and undefined always pass: null is a tombstone and undefined is
 * "unset", and both are handled by the query builders, not here. Everything
 * else runs the type's predicate first, then the column's own `validate`
 * option, if it declares one.
 *
 * @param {string} entity The name of the entity class the write was built for.
 * @param {string} column The column the value is written to.
 * @param {ColumnType} type The column's declared CQL type.
 * @param {unknown} value The value about to be bound.
 * @param {(value: unknown) => boolean | string} [validate] The column's custom validator, if any.
 * @throws {ColumnValidationError} If the value fails the type's predicate or the custom validator.
 */
export function validateColumnValue(
    entity: string,
    column: string,
    type: ColumnType,
    value: unknown,
    validate?: (value: unknown) => boolean | string
): void {
    if (value === null || value === undefined) {
        return;
    }

    const rule = RULES[type];

    // Guarded despite the total Record: a JavaScript caller can declare a type the union does not name
    if (rule !== undefined && !rule.accepts(value)) {
        throw new ColumnValidationError({ column, entity, expected: rule.expected, receivedType: typeof value });
    }

    if (validate !== undefined) {
        const verdict = validate(value);

        if (verdict === false || typeof verdict === 'string') {
            throw new ColumnValidationError({
                column,
                entity,
                expected: verdict === false ? 'a value the column validator accepts' : verdict,
                receivedType: typeof value,
            });
        }
    }
}
