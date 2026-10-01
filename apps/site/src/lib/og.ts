// The social card for a page: /og/<path>.png, made by scripts/og.mjs from the same data. "/" is /og/home.png.
export const ogFor = (path: string) => `/og/${path === "/" ? "home" : path.replace(/^\//, "")}.png`;
