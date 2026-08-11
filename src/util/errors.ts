/** Typed errors for the review pipeline. */

export type ReviewErrorKind = 'checkout' | 'ocr' | 'parse' | 'github' | 'publish' | 'unknown';

export class ReviewError extends Error {
  readonly kind: ReviewErrorKind;

  constructor(kind: ReviewErrorKind, message: string) {
    super(message);
    this.name = 'ReviewError';
    this.kind = kind;
  }
}
