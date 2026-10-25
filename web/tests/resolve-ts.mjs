// SPDX-License-Identifier: GPL-2.0-only
// A relative import without an extension: try the .ts file.
export async function resolve(spec, ctx, next) {
  try {
    return await next(spec, ctx);
  } catch (e) {
    if (spec.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(spec)) return next(`${spec}.ts`, ctx);
    throw e;
  }
}
