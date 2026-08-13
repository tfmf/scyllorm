/**
 * Error types thrown by Scyllorm.
 *
 * Dependency-free on purpose: the repository imports these, so importing model
 * or decorator code here would close a cycle.
 *
 * Catch `ScyllormError` to handle every error the ORM raises for bad input, and
 * switch on `code` rather than on the message — the codes are stable API, the
 * messages are not.
 */

/** How many known column names are listed in a message before it is truncated. */
const MAX_LISTED_COLUMNS = 8;

/** How much of an offending identifier is echoed back, so a large payload cannot flood logs. */
const MAX_ECHOED_LENGTH = 64;

/**
 * Renders an untrusted string for inclusion in a message: truncated, quoted and
 * escaped, so a newline or a quote in the input cannot forge a log line.
 */
function quote(value: string): string {
    const truncated = value.length > MAX_ECHOED_LENGTH ? `${value.slice(0, MAX_ECHOED_LENGTH)}…` : value;

    return JSON.stringify(truncated);
}

/**
 * Renders the known column names, capped so a wide entity does not produce an
 * unreadable message.
 */
function listColumns(columns: readonly string[]): string {
    if (columns.length === 0) {
        return 'the entity declares no columns';
    }

    const shown = columns.slice(0, MAX_LISTED_COLUMNS);
    const remaining = columns.length - shown.length;

    return `Known columns: ${shown.join(', ')}${remaining > 0 ? ` …and ${remaining} more` : ''}.`;
}

/**
 * Levenshtein distance, single-row variant.
 *
 * @param {string} a The first string.
 * @param {string} b The second string.
 * @returns {number} The number of single-character edits between the two.
 */
function editDistance(a: string, b: string): number {
    const row: number[] = [];

    for (let column = 0; column <= b.length; column++) {
        row[column] = column;
    }

    for (let i = 1; i <= a.length; i++) {
        let diagonal = row[0];
        row[0] = i;

        for (let j = 1; j <= b.length; j++) {
            const above = row[j];

            row[j] = Math.min(above + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
            diagonal = above;
        }
    }

    return row[b.length];
}

/**
 * Finds the known column an unknown one was most likely meant to be.
 *
 * A case-only difference is by far the likeliest mistake — lookups are
 * case-sensitive while CQL folds unquoted identifiers — so it wins outright;
 * otherwise a close typo is offered. Work is bounded by the echo limit.
 *
 * @param {string} column The column that was not found.
 * @param {readonly string[]} knownColumns The columns declared on the entity.
 * @returns {string | undefined} The suggestion, if there is a good one.
 */
function suggestColumn(column: string, knownColumns: readonly string[]): string | undefined {
    const needle = column.toLowerCase();

    const folded = knownColumns.find((known) => known.toLowerCase() === needle);

    if (folded !== undefined) {
        return folded;
    }

    // Only accept a typo close enough to be worth suggesting, and never fuzzy-match a payload.
    const threshold = Math.min(2, Math.floor(needle.length / 3));

    if (threshold < 1 || needle.length > MAX_ECHOED_LENGTH) {
        return undefined;
    }

    let best: string | undefined;
    let bestDistance = threshold + 1;

    for (const known of knownColumns) {
        const distance = editDistance(needle, known.toLowerCase());

        if (distance < bestDistance) {
            bestDistance = distance;
            best = known;
        }
    }

    return best;
}

/**
 * Base class for every error Scyllorm raises.
 *
 * Abstract so that `instanceof ScyllormError` always narrows to one of the
 * concrete codes below.
 */
export abstract class ScyllormError extends Error {
    /** Stable, machine-readable discriminator. Safe to switch on. */
    readonly code: string;

    protected constructor(code: string, message: string) {
        super(message);

        this.code = code;
    }
}

/** The structured payload carried by an {@link UnknownColumnError}. */
export interface UnknownColumnDetails {
    /** The column name that was rejected, exactly as it was supplied. */
    column: string;
    /** The name of the entity class the query was built for. */
    entity: string;
    /** The table the entity maps to, if it declares one. */
    table?: string;
    /** Every column declared on the entity. */
    knownColumns: readonly string[];
}

/**
 * Thrown when a query references a column the entity does not declare.
 *
 * CQL cannot parameterize identifiers, so column names are whitelisted against
 * the entity's metadata instead of being escaped. A name that is not on that
 * list never reaches the server.
 */
export class UnknownColumnError extends ScyllormError {
    /** The column name that was rejected, exactly as it was supplied. */
    readonly column: string;

    /** The name of the entity class the query was built for. */
    readonly entity: string;

    /** The table the entity maps to, if it declares one. */
    readonly table?: string;

    /** Every column declared on the entity. */
    readonly knownColumns: readonly string[];

    constructor(details: UnknownColumnDetails) {
        super('SCYLLORM_UNKNOWN_COLUMN', UnknownColumnError.buildMessage(details));

        this.name = 'UnknownColumnError';
        this.column = details.column;
        this.entity = details.entity;
        this.table = details.table;
        this.knownColumns = [...details.knownColumns];
    }

    private static buildMessage(details: UnknownColumnDetails): string {
        const suggestion = suggestColumn(details.column, details.knownColumns);

        return [
            `Unknown column ${quote(details.column)} on entity ${details.entity}` +
                `${details.table ? ` (table ${quote(details.table)})` : ''}.`,
            suggestion !== undefined ? `Did you mean ${quote(suggestion)}?` : undefined,
            listColumns(details.knownColumns),
            'Declare the property with @Column() if the entity is missing it.',
        ]
            .filter((part): part is string => part !== undefined)
            .join(' ');
    }
}

/**
 * Thrown when a query is malformed in a way the ORM will not send to the server:
 * an identifier that is not a legal column name, an unrecognised sort direction,
 * an invalid `LIMIT`, or empty conditions.
 */
export class InvalidQueryError extends ScyllormError {
    constructor(message: string) {
        super('SCYLLORM_INVALID_QUERY', message);

        this.name = 'InvalidQueryError';
    }

    /**
     * Builds the error for a name that is not a legal unquoted CQL identifier —
     * a CQL expression, a quoted identifier or collection access, none of which
     * the ORM models.
     *
     * @param {string} identifier The rejected identifier.
     * @param {string} entity The name of the entity class the query was built for.
     * @returns {InvalidQueryError} The error to throw.
     */
    static invalidIdentifier(identifier: string, entity: string): InvalidQueryError {
        return new InvalidQueryError(
            `Invalid column identifier ${quote(identifier)} on entity ${entity}. ` +
                'A column name must start with a letter and contain only letters, digits and underscores. ' +
                'Use runRawQuery() for CQL expressions, quoted identifiers or collection access.'
        );
    }

    /**
     * Builds the error for two declared columns that CQL cannot tell apart,
     * because it folds unquoted identifiers to lowercase.
     *
     * @param {string} column The column being declared.
     * @param {string} existing The column already declared under the same folded name.
     * @param {string} entity The name of the entity class.
     * @returns {InvalidQueryError} The error to throw.
     */
    static ambiguousColumn(column: string, existing: string, entity: string): InvalidQueryError {
        return new InvalidQueryError(
            `Columns ${quote(existing)} and ${quote(column)} on entity ${entity} are the same column to CQL, ` +
                'which folds unquoted identifiers to lowercase. Rename one of them.'
        );
    }

    /**
     * Builds the error for a sort direction that is not `ASC` or `DESC`.
     *
     * @param {unknown} direction The rejected direction, as supplied.
     * @param {string} column The column it was given for.
     * @param {string} entity The name of the entity class the query was built for.
     * @returns {InvalidQueryError} The error to throw.
     */
    static invalidDirection(direction: unknown, column: string, entity: string): InvalidQueryError {
        return new InvalidQueryError(
            `Invalid sort direction ${quote(String(direction))} for column ${quote(column)} on entity ${entity}. ` +
                "Use 'ASC' or 'DESC'."
        );
    }

    /**
     * Builds the error for a `LIMIT` the driver would reject as an `int` bind
     * value, caught locally so the message names the caller's input rather than
     * the driver's own type.
     *
     * @param {unknown} limit The rejected limit, as supplied.
     * @param {string} entity The name of the entity class the query was built for.
     * @returns {InvalidQueryError} The error to throw.
     */
    static invalidLimit(limit: unknown, entity: string): InvalidQueryError {
        return new InvalidQueryError(
            `Invalid limit ${quote(String(limit))} on entity ${entity}. ` +
                'A limit must be an integer from 1 to 2147483647, or a numeric string of one.'
        );
    }

    /**
     * Builds the error for a clause with no columns in it, which would be
     * emitted as a dangling `WHERE`, `ORDER BY` or `IN ()`.
     *
     * @param {string} clause The clause that came up empty, named as the caller sees it.
     * @param {string} entity The name of the entity class the query was built for.
     * @returns {InvalidQueryError} The error to throw.
     */
    static emptyConditions(clause: string, entity: string): InvalidQueryError {
        return new InvalidQueryError(
            `Empty ${clause} on entity ${entity} would produce invalid CQL. Pass at least one column.`
        );
    }

    /**
     * Builds the error for a condition compared against null or undefined.
     *
     * @param {string} column The column the condition was given for.
     * @param {string} entity The name of the entity class the query was built for.
     * @returns {InvalidQueryError} The error to throw.
     */
    static nullCondition(column: string, entity: string): InvalidQueryError {
        return new InvalidQueryError(
            `Condition on column ${quote(column)} of entity ${entity} is null or undefined. ` +
                'CQL has no null comparison; drop the condition instead.'
        );
    }

    /**
     * Builds the error for a condition value the driver cannot bind.
     *
     * @param {string} column The column the condition was given for.
     * @param {string} entity The name of the entity class the query was built for.
     * @param {string} operator The operator the value was given for.
     * @param {unknown} value The rejected value, reported by type only.
     * @returns {InvalidQueryError} The error to throw.
     */
    static invalidConditionValue(column: string, entity: string, operator: string, value: unknown): InvalidQueryError {
        return new InvalidQueryError(
            `Invalid value of type ${typeof value} for operator ${operator} on column ${quote(column)} ` +
                `of entity ${entity}. A condition value must be a string, number, boolean or Buffer.`
        );
    }

    /**
     * Builds the error for an `IN` condition whose values are not a list.
     *
     * @param {string} column The column the condition was given for.
     * @param {string} entity The name of the entity class the query was built for.
     * @param {unknown} value The rejected value, reported by type only.
     * @returns {InvalidQueryError} The error to throw.
     */
    static invalidInValues(column: string, entity: string, value: unknown): InvalidQueryError {
        return new InvalidQueryError(
            `IN condition on column ${quote(column)} of entity ${entity} expects an array of values, ` +
                `received ${typeof value}. Build it with In([…]).`
        );
    }

    /**
     * Builds the error for an `IN` condition with no values, which CQL rejects
     * outright rather than treating as a query that matches nothing.
     *
     * @param {string} column The column the condition was given for.
     * @param {string} entity The name of the entity class the query was built for.
     * @returns {InvalidQueryError} The error to throw.
     */
    static emptyInValues(column: string, entity: string): InvalidQueryError {
        return new InvalidQueryError(
            `IN condition on column ${quote(column)} of entity ${entity} has no values. ` +
                'An empty IN matches nothing; skip the query instead.'
        );
    }

    /**
     * Builds the error for a named parameter a raw query references but the
     * caller never supplied a value for.
     *
     * @param {string} parameter The parameter name, without its leading colon.
     * @param {string} entity The name of the entity class the query was built for.
     * @returns {InvalidQueryError} The error to throw.
     */
    static missingParameter(parameter: string, entity: string): InvalidQueryError {
        return new InvalidQueryError(
            `Missing value for parameter ${quote(parameter)} in a raw query on entity ${entity}. ` +
                'Every :name in the query needs a matching key in the params object.'
        );
    }

    /**
     * Builds the error for an operator the query builder does not emit.
     *
     * @param {unknown} operator The rejected operator, as supplied.
     * @param {string} column The column it was given for.
     * @param {string} entity The name of the entity class the query was built for.
     * @returns {InvalidQueryError} The error to throw.
     */
    static unsupportedOperator(operator: unknown, column: string, entity: string): InvalidQueryError {
        return new InvalidQueryError(
            `Unsupported operator ${quote(String(operator))} on column ${quote(column)} of entity ${entity}. ` +
                'Supported operators are IN, =, <, <=, > and >=.'
        );
    }
}

/**
 * Thrown when the driver rejects a query the ORM was asked to run.
 *
 * Unlike the other two, this is not bad input caught locally — the statement
 * reached the server and came back failing. The driver's own error is kept
 * whole on `cause`, so its type, message and stack survive.
 */
export class QueryFailedError extends ScyllormError {
    /**
     * The error the driver threw.
     *
     * Declared as a field rather than passed to `super()`: `lib` is `ES2020`,
     * where the `cause` constructor option is not typed.
     */
    readonly cause: unknown;

    /** The CQL that failed, exactly as it was handed to the driver. */
    readonly query: string;

    constructor(query: string, cause: unknown) {
        super('SCYLLORM_QUERY_FAILED', `Query failed: ${cause instanceof Error ? cause.message : String(cause)}`);

        this.name = 'QueryFailedError';
        this.cause = cause;
        this.query = query;
    }
}
