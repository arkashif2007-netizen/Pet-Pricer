import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseScanOptions } from '../../src/server/http.ts';

describe('parseScanOptions', () => {
  it('leaves every option absent when no parameters are supplied', () => {
    // Regression: Number(null) is 0, which made an omitted feePct mean a 0%
    // fee. That reported three verified loss-making pets as profitable.
    const options = parseScanOptions(new URLSearchParams());
    assert.deepEqual(options, {});
    assert.equal('feePct' in options, false);
  });

  it('leaves absent options absent even when others are present', () => {
    const options = parseScanOptions(new URLSearchParams({ limit: '10' }));
    assert.equal(options.limit, 10);
    assert.equal('feePct' in options, false);
    assert.equal('maxNormalPrice' in options, false);
    assert.equal('units' in options, false);
  });

  it('accepts a fee as a fraction or a percentage', () => {
    assert.equal(parseScanOptions(new URLSearchParams({ feePct: '0.25' })).feePct, 0.25);
    assert.equal(parseScanOptions(new URLSearchParams({ feePct: '25' })).feePct, 0.25);
  });

  it('honours an explicit zero fee', () => {
    // Zero is a meaningful value and must survive; only absence is absence.
    assert.equal(parseScanOptions(new URLSearchParams({ feePct: '0' })).feePct, 0);
  });

  it('ignores blank and unparseable values', () => {
    assert.deepEqual(parseScanOptions(new URLSearchParams({ feePct: '' })), {});
    assert.deepEqual(parseScanOptions(new URLSearchParams({ feePct: 'abc' })), {});
    assert.deepEqual(parseScanOptions(new URLSearchParams({ maxNormalPrice: 'NaN' })), {});
  });

  it('rejects nonsensical numeric input', () => {
    assert.equal('maxNormalPrice' in parseScanOptions(new URLSearchParams({ maxNormalPrice: '-3' })), false);
    assert.equal('units' in parseScanOptions(new URLSearchParams({ units: '1' })), false);
    assert.equal('units' in parseScanOptions(new URLSearchParams({ units: '2.5' })), false);
    assert.equal('limit' in parseScanOptions(new URLSearchParams({ limit: '-1' })), false);
  });

  it('caps the page size', () => {
    assert.equal(parseScanOptions(new URLSearchParams({ limit: '99999' })).limit, 5_000);
  });

  it('only accepts known enum values', () => {
    assert.equal(parseScanOptions(new URLSearchParams({ verdict: 'craft' })).verdict, 'craft');
    assert.equal(parseScanOptions(new URLSearchParams({ verdict: 'all' })).verdict, 'all');
    assert.equal('verdict' in parseScanOptions(new URLSearchParams({ verdict: 'bogus' })), false);

    assert.equal(parseScanOptions(new URLSearchParams({ sort: 'ratio' })).sortBy, 'ratio');
    assert.equal('sortBy' in parseScanOptions(new URLSearchParams({ sort: 'bogus' })), false);
  });

  it('treats includeLosses as an explicit opt-in', () => {
    assert.equal(parseScanOptions(new URLSearchParams({ includeLosses: 'true' })).includeLosses, true);
    assert.equal('includeLosses' in parseScanOptions(new URLSearchParams({ includeLosses: '1' })), false);
  });
});
