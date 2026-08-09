import "@testing-library/jest-dom/vitest";
import { render,screen,waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe,expect,it } from "vitest";
import { RankedBallot, RehearsalWorkspace } from "./App.tsx";

describe("ranked ballot accessibility",()=>{
  it("provides keyboard-operable reorder controls, selection context, and focus retention",async()=>{const user=userEvent.setup();render(<RankedBallot/>);const down=screen.getByRole("button",{name:"Move North Star down"});await user.click(down);await waitFor(()=>expect(screen.getByRole("button",{name:/North Star Key:/})).toHaveFocus());expect(screen.getByText("Selected song")).toBeVisible();expect(screen.getByText("North Star moved to position 2 of 3")).toBeInTheDocument();});
});

describe("rehearsal coordination accessibility",()=>{
  it("keeps selected arrangement context obvious and supports assignment/readiness workflow by keyboard",async()=>{const user=userEvent.setup();render(<RehearsalWorkspace/>);const second=screen.getByRole("button",{name:/Open Road arrangement/});await user.tab();while(document.activeElement!==second)await user.tab();await user.keyboard("{Enter}");expect(screen.getByRole("heading",{name:"Open Road"})).toBeVisible();expect(screen.getByText("Selected arrangement")).toBeVisible();await user.click(screen.getByRole("button",{name:"Offer lead vocal to Avery"}));expect(screen.getByRole("status")).toHaveTextContent("Offer sent to Avery");expect(screen.getByRole("button",{name:"Mark lead vocal rehearsal-ready"})).toBeEnabled();});
});
