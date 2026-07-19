/**
 * Unit tests for the project lifecycle FSM.
 *
 * Coverage:
 *   - Every legal transition (canTransition + assertTransition)
 *   - Representative illegal transitions (including the ones called out in the plan)
 *   - Terminal-state guards
 *   - validNextStates shape
 *   - assertTransition error structure (cause.kind)
 */

import { describe, expect, it } from 'bun:test';
import { resolveProjectTransition } from '../jobs/transition-policy';
import {
  type ProjectState,
  assertTransition,
  canTransition,
  isTerminal,
  validNextStates,
} from './fsm';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** All legal (from, to) pairs derived from the transition table. */
const LEGAL_TRANSITIONS: [ProjectState, ProjectState][] = [
  // draft
  ['draft', 'images_ready'],
  ['draft', 'cancelled'],
  ['draft', 'failed'],
  // images_ready
  ['images_ready', 'awaiting_decision'],
  ['images_ready', 'cancelled'],
  ['images_ready', 'failed'],
  // awaiting_decision
  ['awaiting_decision', 'composing'], // WS2: Continue → author the clip composition
  ['awaiting_decision', 'animating'], // legacy direct path (back-compat)
  ['awaiting_decision', 'images_ready'], // retry
  ['awaiting_decision', 'cancelled'],
  ['awaiting_decision', 'failed'],
  // composing (WS2)
  ['composing', 'animating'], // commit composition → paid animate
  ['composing', 'images_ready'], // bounce back to image-correction
  ['composing', 'cancelled'],
  ['composing', 'failed'],
  // animating
  ['animating', 'clips_ready'],
  ['animating', 'cancelled'],
  ['animating', 'failed'],
  // clips_ready
  ['clips_ready', 'editing'],
  ['clips_ready', 'animating'], // C2: re-animate a clip from clips_ready
  ['clips_ready', 'cancelled'],
  ['clips_ready', 'failed'],
  // editing
  ['editing', 'rendered'],
  ['editing', 'animating'], // C2: re-animate a clip from editing
  ['editing', 'cancelled'],
  ['editing', 'failed'],
  // rendered → editing: re-open for re-edit/re-export (#24)
  ['rendered', 'editing'],
];

/** Illegal (from, to) pairs — representative, not exhaustive. */
const ILLEGAL_TRANSITIONS: [ProjectState, ProjectState, string][] = [
  // Skip-ahead
  ['draft', 'rendered', 'draft→rendered (skip-ahead)'],
  ['draft', 'animating', 'draft→animating (skip-ahead)'],
  ['draft', 'clips_ready', 'draft→clips_ready (skip-ahead)'],
  ['draft', 'editing', 'draft→editing (skip-ahead)'],
  ['images_ready', 'rendered', 'images_ready→rendered (skip-ahead)'],
  ['images_ready', 'animating', 'images_ready→animating (skip-ahead)'],
  ['awaiting_decision', 'rendered', 'awaiting_decision→rendered (skip-ahead)'],
  ['awaiting_decision', 'clips_ready', 'awaiting_decision→clips_ready (skip-ahead)'],
  ['composing', 'clips_ready', 'composing→clips_ready (skip-ahead)'],
  ['composing', 'rendered', 'composing→rendered (skip-ahead)'],
  ['composing', 'draft', 'composing→draft (backwards)'],
  // Backwards (other than the legal retry)
  ['animating', 'draft', 'animating→draft (backwards)'],
  ['animating', 'images_ready', 'animating→images_ready (backwards)'],
  ['clips_ready', 'draft', 'clips_ready→draft (backwards)'],
  ['editing', 'draft', 'editing→draft (backwards)'],
  // Out-of-order from terminal states
  ['cancelled', 'draft', 'cancelled→draft (from terminal)'],
  ['failed', 'draft', 'failed→draft (from terminal)'],
  ['rendered', 'draft', 'rendered→draft (from terminal)'],
  // Explicitly called out in the plan
  ['draft', 'rendered', 'plan example: draft→rendered rejected'],
  ['awaiting_decision', 'draft', 'plan example: continue from draft rejected (inverse)'],
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FSM — canTransition', () => {
  describe('legal transitions', () => {
    for (const [from, to] of LEGAL_TRANSITIONS) {
      it(`${from} → ${to}`, () => {
        expect(canTransition(from, to)).toBe(true);
      });
    }
  });

  describe('illegal transitions', () => {
    for (const [from, to, label] of ILLEGAL_TRANSITIONS) {
      it(`${label}`, () => {
        expect(canTransition(from, to)).toBe(false);
      });
    }
  });
});

describe('FSM — assertTransition', () => {
  describe('does not throw on legal transitions', () => {
    for (const [from, to] of LEGAL_TRANSITIONS) {
      it(`${from} → ${to}`, () => {
        expect(() => assertTransition(from, to)).not.toThrow();
      });
    }
  });

  describe('throws on illegal transitions', () => {
    for (const [from, to, label] of ILLEGAL_TRANSITIONS) {
      it(`${label}`, () => {
        expect(() => assertTransition(from, to)).toThrow();
      });
    }
  });

  it('thrown error has cause.kind === "illegal_transition"', () => {
    let caught: unknown;
    try {
      assertTransition('draft', 'rendered');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught).toBeInstanceOf(Error);
    const cause = (caught as Error & { cause?: { kind?: string; from?: string; to?: string } })
      .cause;
    expect(cause?.kind).toBe('illegal_transition');
    expect(cause?.from).toBe('draft');
    expect(cause?.to).toBe('rendered');
  });

  it('thrown error message includes both states', () => {
    let msg = '';
    try {
      assertTransition('animating', 'draft');
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain('animating');
    expect(msg).toContain('draft');
  });
});

describe('FSM — isTerminal', () => {
  it('rendered is terminal', () => expect(isTerminal('rendered')).toBe(true));
  it('cancelled is terminal', () => expect(isTerminal('cancelled')).toBe(true));
  it('failed is terminal', () => expect(isTerminal('failed')).toBe(true));

  const nonTerminal: ProjectState[] = [
    'draft',
    'images_ready',
    'awaiting_decision',
    'composing',
    'animating',
    'clips_ready',
    'editing',
  ];
  for (const state of nonTerminal) {
    it(`${state} is not terminal`, () => expect(isTerminal(state)).toBe(false));
  }
});

describe('FSM — validNextStates', () => {
  it('draft can go to images_ready, cancelled, failed', () => {
    const next = validNextStates('draft');
    expect(next.has('images_ready')).toBe(true);
    expect(next.has('cancelled')).toBe(true);
    expect(next.has('failed')).toBe(true);
    expect(next.size).toBe(3);
  });

  it('awaiting_decision includes composing, animating and images_ready (retry)', () => {
    const next = validNextStates('awaiting_decision');
    expect(next.has('composing')).toBe(true);
    expect(next.has('animating')).toBe(true);
    expect(next.has('images_ready')).toBe(true);
  });

  it('composing can go to animating and back to images_ready', () => {
    const next = validNextStates('composing');
    expect(next.has('animating')).toBe(true);
    expect(next.has('images_ready')).toBe(true);
    expect(next.has('cancelled')).toBe(true);
    expect(next.has('failed')).toBe(true);
    expect(next.size).toBe(4);
  });

  it('rendered has one next state: editing (re-open, #24)', () => {
    const next = validNextStates('rendered');
    expect(next.has('editing')).toBe(true);
    expect(next.size).toBe(1);
  });

  it('cancelled has no next states', () => {
    expect(validNextStates('cancelled').size).toBe(0);
  });

  it('failed has no next states', () => {
    expect(validNextStates('failed').size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Animation transition policy — clips_ready over arbitrary N (WS2)
//
// The policy advances out of `animating` only when EVERY clip is terminal, for
// any clip count N (not a hard-coded 4): clips_ready if ≥1 succeeded, failed if
// all failed, and stays in `animating` (null) while any sibling is in flight.
// ---------------------------------------------------------------------------

describe('transition-policy — animation clips_ready over N', () => {
  const animation = (over: Partial<Parameters<typeof resolveProjectTransition>[0]>) =>
    resolveProjectTransition({
      kind: 'animation',
      result: 'completed',
      outstandingSiblings: 0,
      failedSiblings: 0,
      completedSiblings: 0,
      ...over,
    });

  for (const n of [1, 4, 9, 20]) {
    it(`N=${n}: all clips completed → clips_ready`, () => {
      expect(animation({ completedSiblings: n })).toBe('clips_ready');
    });

    it(`N=${n}: all clips failed → failed`, () => {
      expect(animation({ result: 'failed', failedSiblings: n })).toBe('failed');
    });

    it(`N=${n}: still has in-flight sibling → stay (null)`, () => {
      expect(animation({ outstandingSiblings: 1, completedSiblings: n - 1 })).toBeNull();
    });
  }

  it('N=9 partial: 1 failed, 8 succeeded, none outstanding → clips_ready', () => {
    expect(animation({ failedSiblings: 1, completedSiblings: 8 })).toBe('clips_ready');
  });
});
