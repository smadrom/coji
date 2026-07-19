import { describe, expect, test } from 'bun:test';
import { resolveProjectTransition } from './transition-policy.ts';

describe('resolveProjectTransition', () => {
  test('image success → images_ready', () => {
    expect(
      resolveProjectTransition({
        kind: 'image',
        result: 'completed',
        outstandingSiblings: 0,
        failedSiblings: 0,
        completedSiblings: 1,
      }),
    ).toBe('images_ready');
  });

  test('image failure → failed', () => {
    expect(
      resolveProjectTransition({
        kind: 'image',
        result: 'failed',
        outstandingSiblings: 0,
        failedSiblings: 0,
        completedSiblings: 0,
      }),
    ).toBe('failed');
  });

  test('animation success advances to clips_ready when all 4 succeed', () => {
    expect(
      resolveProjectTransition({
        kind: 'animation',
        result: 'completed',
        outstandingSiblings: 0,
        failedSiblings: 0,
        completedSiblings: 4,
      }),
    ).toBe('clips_ready');
  });

  test('animation success with outstanding siblings stays put (null)', () => {
    expect(
      resolveProjectTransition({
        kind: 'animation',
        result: 'completed',
        outstandingSiblings: 2,
        failedSiblings: 0,
        completedSiblings: 2,
      }),
    ).toBeNull();
  });

  test('animation: partial success (1 clip failed, rest done) → clips_ready', () => {
    // A terminally-failed clip (e.g. a face-less shot) must NOT strand the
    // project; once all clips are settled with ≥1 success → clips_ready.
    expect(
      resolveProjectTransition({
        kind: 'animation',
        result: 'completed',
        outstandingSiblings: 0,
        failedSiblings: 1,
        completedSiblings: 3,
      }),
    ).toBe('clips_ready');
  });

  test('animation: a clip failure that settles the last clip → clips_ready', () => {
    // The failing clip is the last to settle; 3 already succeeded.
    expect(
      resolveProjectTransition({
        kind: 'animation',
        result: 'failed',
        outstandingSiblings: 0,
        failedSiblings: 1,
        completedSiblings: 3,
      }),
    ).toBe('clips_ready');
  });

  test('animation: a clip failure with siblings still in flight stays put', () => {
    expect(
      resolveProjectTransition({
        kind: 'animation',
        result: 'failed',
        outstandingSiblings: 2,
        failedSiblings: 1,
        completedSiblings: 1,
      }),
    ).toBeNull();
  });

  test('animation: all clips failed → failed', () => {
    expect(
      resolveProjectTransition({
        kind: 'animation',
        result: 'failed',
        outstandingSiblings: 0,
        failedSiblings: 4,
        completedSiblings: 0,
      }),
    ).toBe('failed');
  });

  test('render success → rendered, failure → editing', () => {
    expect(
      resolveProjectTransition({
        kind: 'render',
        result: 'completed',
        outstandingSiblings: 0,
        failedSiblings: 0,
        completedSiblings: 1,
      }),
    ).toBe('rendered');
    expect(
      resolveProjectTransition({
        kind: 'render',
        result: 'failed',
        outstandingSiblings: 0,
        failedSiblings: 0,
        completedSiblings: 0,
      }),
    ).toBe('editing');
  });
});
