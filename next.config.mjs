import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: {
    unoptimized: true
  },
  trailingSlash: true,
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      mermaid: path.join(dirname, "src/lib/mermaid-stub.ts")
    };
    return config;
  }
};

export default nextConfig;
