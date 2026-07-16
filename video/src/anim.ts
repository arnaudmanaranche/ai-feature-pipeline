import { Easing, interpolate } from 'remotion';

// Opacity 0 -> 1 over [start, start+dur], clamped.
export const fadeIn = (frame: number, start: number, dur: number) =>
  interpolate(frame, [start, start + dur], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });

// Opacity 1 -> 0 over [start, start+dur], clamped.
export const fadeOut = (frame: number, start: number, dur: number) =>
  interpolate(frame, [start, start + dur], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.in(Easing.cubic),
  });

// A gentle upward drift paired with a fadeIn, the standard "text arrives" move.
export const riseIn = (frame: number, start: number, dur: number, distance = 18) =>
  interpolate(frame, [start, start + dur], [distance, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
