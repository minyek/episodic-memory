import { describe, it, expect } from 'vitest';
import { isAuthFailure, SummarizerSdkError } from '../src/summarizer.js';

// Behaviour (spec AC 2): a logged-out CLI is an auth failure even though the SDK
// reports it as subtype "success" with the text in the result.
describe('isAuthFailure', () => {
  it('matches "Not logged in" reported as subtype success', () => {
    const error = new SummarizerSdkError('success', 'sess-1', null, 'Not logged in · Please run /login');
    expect(isAuthFailure(error)).toBe(true);
  });

  it('does not match an unrelated error', () => {
    expect(isAuthFailure(new SummarizerSdkError('success', 'sess-1', 529, 'API Error: 529 Overloaded'))).toBe(false);
    expect(isAuthFailure(new Error('spawn ENOENT'))).toBe(false);
  });
});
