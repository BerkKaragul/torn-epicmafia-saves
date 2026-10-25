"use client";

import { createContext, useContext } from "react";

// The running event, if any — read once per page render by the root layout and
// handed down so client components (nav, splash, decor) agree with the server
// on whether event mode is on, with no extra fetch and no hydration mismatch.
export interface ActiveEvent {
  id: number;
  name: string;
  theme: string;
  ends_at: string;
}

const EventContext = createContext<ActiveEvent | null>(null);

export function EventProvider({
  value,
  children,
}: {
  value: ActiveEvent | null;
  children: React.ReactNode;
}) {
  return <EventContext.Provider value={value}>{children}</EventContext.Provider>;
}

export function useActiveEvent(): ActiveEvent | null {
  return useContext(EventContext);
}
