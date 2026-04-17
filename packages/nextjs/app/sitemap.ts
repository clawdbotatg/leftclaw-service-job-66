import type { MetadataRoute } from "next";

const baseUrl = process.env.NEXT_PUBLIC_PRODUCTION_URL || "https://clawdpfp.com";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [
    { url: `${baseUrl}/`, lastModified, changeFrequency: "hourly", priority: 1 },
    { url: `${baseUrl}/generate`, lastModified, changeFrequency: "daily", priority: 0.8 },
  ];
}
