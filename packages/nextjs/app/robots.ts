import type { MetadataRoute } from "next";

const baseUrl = process.env.NEXT_PUBLIC_PRODUCTION_URL || "https://clawdpfp.com";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/"],
    },
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
