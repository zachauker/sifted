/**
 * The largest image we accept, whether downloaded from a publisher or
 * uploaded from a phone. A modern phone's full-resolution JPEG is 3-8 MB, so
 * this leaves room without letting one request hold a large buffer.
 *
 * Its own module, with no imports, because the upload form checks it in the
 * browser before sending anything — and `@/lib/images` pulls in sharp, which
 * must never reach a client bundle.
 */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024
