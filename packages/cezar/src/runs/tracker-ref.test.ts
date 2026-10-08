import { describe, expect, it } from 'vitest';
import { trackerReadScope } from '@open-mercato/cezar-contract';
import { trackerRefOf, withTrackerRef } from './tracker-ref.ts';

const provenance = {
  automationId: 'a1',
  automationRevision: 1,
  receiptId: 'rc1',
  provider: 'jira' as const,
  key: 'ABC-41',
  url: 'https://acme.atlassian.net/browse/ABC-41',
};
const association = {
  kind: 'jira' as const,
  source: { id: 'cloud', webUrl: 'https://acme.atlassian.net' },
  externalId: '100',
  externalName: 'ABC',
};

describe('trackerRefOf (task phases, step 9)', () => {
  it('projects only the display fields, plus the launching association scope when recorded', () => {
    expect(trackerRefOf({ automationTracker: { ...provenance, association } })).toEqual({
      provider: 'jira',
      key: 'ABC-41',
      url: 'https://acme.atlassian.net/browse/ABC-41',
      scope: trackerReadScope(association),
    });
  });

  it('omits scope for legacy provenance and the whole key without provenance', () => {
    expect(trackerRefOf({ automationTracker: provenance })).toEqual({
      provider: 'jira',
      key: 'ABC-41',
      url: 'https://acme.atlassian.net/browse/ABC-41',
    });
    const plain = withTrackerRef({ automationTracker: undefined, id: 'r1' });
    expect('trackerRef' in plain).toBe(false);
  });
});
