/** @type {import('next').NextConfig} */
const nextConfig = {
  // ffmpeg.wasm loads its core + wasm from a CDN at runtime, so nothing special
  // is needed at build time. Turbopack (the Next 16 default) handles the rest.
  turbopack: {},
};

export default nextConfig;
