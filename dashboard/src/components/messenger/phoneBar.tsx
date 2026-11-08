// dashboard/src/components/messenger/phoneBar.tsx
// On a phone the shell puts "back" and "Painel do Hermes" in a strip above the open screen. A screen with its own
// header (the conversation) takes them into that header instead, so the phone shows one strip, not two.

import React from "react";

export interface PhoneBar {
  back: React.ReactNode;
  hermes: React.ReactNode;
  claim: () => () => void;  // the shell hides its own strip while a screen holds the claim
}

export const PhoneBarContext = React.createContext<PhoneBar | null>(null);

/** The shell's back and Hermes controls for this screen's header; null on a wide screen. */
export function usePhoneBar(): PhoneBar | null {
  const bar = React.useContext(PhoneBarContext);
  const claim = bar?.claim;
  React.useLayoutEffect(() => claim?.(), [claim]);
  return bar;
}

/** On a phone the shell shows the contact list OR the open screen. A place chosen outside its rail (the search palette's "Ver Rotinas") changes the tab
 *  behind the list: this brings the screen forward, like a tap on the tab bar does. Null outside the shell; a wide screen shows both already. */
export const OpenScreenContext = React.createContext<(() => void) | null>(null);
export const useOpenScreen = () => React.useContext(OpenScreenContext);
