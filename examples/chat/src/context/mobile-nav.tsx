import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

/** Drawer/sidebar state: left = channel list, right = members (drawer on mobile, collapsible sidebar on desktop). */
interface MobileNav {
  leftOpen: boolean;
  rightOpen: boolean;
  openLeft: () => void;
  closeLeft: () => void;
  toggleRight: () => void;
  closeRight: () => void;
  closeAll: () => void;
}

const MobileNavContext = createContext<MobileNav | null>(null);

export function useMobileNav(): MobileNav {
  const ctx = useContext(MobileNavContext);
  if (!ctx) throw new Error("useMobileNav must be used within MobileNavProvider");
  return ctx;
}

export function MobileNavProvider({ children }: { children: ReactNode }) {
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);

  const value = useMemo<MobileNav>(
    () => ({
      leftOpen,
      rightOpen,
      // Opening one drawer always closes the other so they never stack.
      openLeft: () => {
        setRightOpen(false);
        setLeftOpen(true);
      },
      closeLeft: () => setLeftOpen(false),
      toggleRight: () => {
        setLeftOpen(false);
        setRightOpen((v) => !v);
      },
      closeRight: () => setRightOpen(false),
      closeAll: () => {
        setLeftOpen(false);
        setRightOpen(false);
      },
    }),
    [leftOpen, rightOpen],
  );

  return <MobileNavContext.Provider value={value}>{children}</MobileNavContext.Provider>;
}
