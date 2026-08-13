#!/usr/bin/env node
/**
 * Keep the README's coverage badge in step with the coverage the suite actually measured.
 *
 * A hand-written badge is a number nobody updates, so it drifts into a lie. This reads the
 * real figure out of `coverage/coverage-summary.json` and either rewrites the badge
 * (`--write`) or fails if it is stale (the default), which is what CI runs. The badge can
 * therefore only ever say what the last run proved.
 *
 * Requires `npm run test:coverage` to have run first.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUMMARY = join(ROOT, 'coverage', 'coverage-summary.json');
const README = join(ROOT, 'README.md');

// Matched by its shields.io path rather than by line number, so the badge can be moved
// around the README header without breaking this script.
const BADGE = /!\[Coverage\]\(https:\/\/img\.shields\.io\/badge\/coverage-\d+%25-[a-z]+\)/;

const COLOURS = [
    [90, 'brightgreen'],
    [80, 'green'],
    [70, 'yellowgreen'],
    [60, 'yellow'],
    [50, 'orange'],
];

/**
 * Pick the badge colour for a coverage percentage.
 *
 * @param {number} pct The measured percentage.
 * @returns {string} A shields.io colour name.
 */
function colourFor(pct) {
    const band = COLOURS.find(([floor]) => pct >= floor);

    return band ? band[1] : 'red';
}

/**
 * Read line coverage out of the summary the `json-summary` reporter wrote.
 *
 * Line coverage rather than statements, branches or functions: it is the figure a
 * "coverage" badge is universally read as, and the one the README documents.
 *
 * @returns {number} The measured line coverage percentage.
 */
function readCoverage() {
    try {
        return JSON.parse(readFileSync(SUMMARY, 'utf8')).total.lines.pct;
    } catch {
        console.error(`No coverage summary at ${SUMMARY}. Run \`npm run test:coverage\` first.`);
        process.exit(1);
    }
}

const write = process.argv.includes('--write');

// Floored rather than rounded, on both counts: the badge must never claim coverage the
// suite did not reach, and a whole percent is stable enough that ordinary changes do not
// churn the README.
const pct = Math.floor(readCoverage());
const badge = `![Coverage](https://img.shields.io/badge/coverage-${pct}%25-${colourFor(pct)})`;
const readme = readFileSync(README, 'utf8');

if (!BADGE.test(readme)) {
    console.error('No coverage badge found in README.md — add one, or fix the pattern in this script.');
    process.exit(1);
}

const updated = readme.replace(BADGE, badge);

if (updated === readme) {
    console.log(`README coverage badge is up to date at ${pct}%.`);
    process.exit(0);
}

if (!write) {
    console.error(`README coverage badge is stale: the suite measured ${pct}%. Run \`npm run coverage:badge\`.`);
    process.exit(1);
}

writeFileSync(README, updated);
console.log(`README coverage badge updated to ${pct}%.`);
