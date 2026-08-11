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
}
