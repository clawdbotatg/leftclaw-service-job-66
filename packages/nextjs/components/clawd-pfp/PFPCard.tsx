"use client";

import { Address } from "@scaffold-ui/components";
import { mainnet } from "viem/chains";

type PFPCardProps = {
  tokenId: number;
  owner: string;
  image: string | null;
  description: string | null;
};

const OPENSEA_COLLECTION = "0xb5741b033c45330a34952436a34b1b25a208af10";

export const PFPCard = ({ tokenId, owner, image, description }: PFPCardProps) => {
  const openseaUrl = `https://opensea.io/item/ethereum/${OPENSEA_COLLECTION}/${tokenId}`;

  return (
    <div className="card bg-base-100 shadow-xl overflow-hidden">
      <a
        href={openseaUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="block transition-opacity hover:opacity-90"
      >
        <figure className="bg-base-300 aspect-square flex items-center justify-center">
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt={`CLAWD PFP #${tokenId}`} className="w-full h-full object-cover" />
          ) : (
            <div className="text-4xl opacity-30">⚠️</div>
          )}
        </figure>
      </a>
      <div className="card-body p-4">
        <a href={openseaUrl} target="_blank" rel="noopener noreferrer" className="link link-hover">
          <h3 className="card-title text-sm font-bold">CLAWD PFP #{tokenId}</h3>
        </a>
        <div className="flex items-center gap-1 text-xs">
          <span className="opacity-60">Owner:</span>
          <Address address={owner as `0x${string}`} chain={mainnet} size="xs" />
        </div>
        {description && <p className="text-xs opacity-70 line-clamp-2 italic">&quot;{description}&quot;</p>}
      </div>
    </div>
  );
};
