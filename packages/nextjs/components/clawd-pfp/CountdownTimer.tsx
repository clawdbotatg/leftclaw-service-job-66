"use client";

import { useEffect, useState } from "react";

type CountdownTimerProps = {
  /** The mint deadline as a Unix timestamp (seconds) */
  mintDeadline: bigint | undefined;
  /** Whether the deadline data is still loading */
  isLoading?: boolean;
};

type TimeRemaining = {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  total: number;
};

function getTimeRemaining(deadline: number): TimeRemaining {
  const now = Math.floor(Date.now() / 1000);
  const total = deadline - now;

  if (total <= 0) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0, total: 0 };
  }

  return {
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
    total,
  };
}

export const CountdownTimer = ({ mintDeadline, isLoading }: CountdownTimerProps) => {
  const [timeRemaining, setTimeRemaining] = useState<TimeRemaining | null>(null);

  useEffect(() => {
    if (!mintDeadline) return;

    const deadline = Number(mintDeadline);

    const updateTimer = () => {
      setTimeRemaining(getTimeRemaining(deadline));
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);

    return () => clearInterval(interval);
  }, [mintDeadline]);

  if (isLoading || !timeRemaining) {
    return (
      <div className="text-center">
        <span className="loading loading-spinner loading-sm"></span>
      </div>
    );
  }

  if (timeRemaining.total <= 0) {
    return (
      <div className="text-center">
        <div className="badge badge-error badge-lg gap-2 text-lg font-bold px-6 py-4">Collection Frozen</div>
      </div>
    );
  }

  // Urgency styling
  const isUrgent = timeRemaining.total < 3600; // < 1 hour
  const isWarning = timeRemaining.total < 86400; // < 1 day
  const isGracePeriod = timeRemaining.total < 300; // < 5 minutes

  const textColorClass = isGracePeriod
    ? "text-error animate-pulse"
    : isUrgent
      ? "text-error"
      : isWarning
        ? "text-warning"
        : "text-base-content";

  const pad = (n: number) => n.toString().padStart(2, "0");

  return (
    <div className={`text-center ${textColorClass}`}>
      <div className="flex items-center justify-center gap-1 text-lg font-mono font-bold">
        {timeRemaining.days > 0 && (
          <>
            <span className="countdown">
              <span style={{ "--value": timeRemaining.days } as React.CSSProperties}></span>
            </span>
            <span className="text-sm font-normal">d</span>
          </>
        )}
        <span>{pad(timeRemaining.hours)}</span>
        <span>:</span>
        <span>{pad(timeRemaining.minutes)}</span>
        <span>:</span>
        <span>{pad(timeRemaining.seconds)}</span>
      </div>
      <p className="text-xs opacity-70 mt-1">{isGracePeriod ? "Minting closing soon..." : "left to mint"}</p>
      <p className="text-xs opacity-50 mt-2 max-w-md mx-auto">
        Enforced by the smart contract on Ethereum — no extensions possible.{" "}
        <a
          href="https://etherscan.io/address/0xb5741b033c45330a34952436a34b1b25a208af10#code"
          target="_blank"
          rel="noopener noreferrer"
          className="link link-hover"
        >
          View verified contract
        </a>
      </p>
    </div>
  );
};
