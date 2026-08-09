import "@testing-library/jest-dom/vitest";
import { render,screen,waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe,expect,it } from "vitest";
import { LiveWorkspace, RankedBallot, RehearsalWorkspace } from "./App.tsx";

describe("ranked ballot accessibility",()=>{
  it("provides keyboard-operable reorder controls, selection context, and focus retention",async()=>{const user=userEvent.setup();render(<RankedBallot/>);const down=screen.getByRole("button",{name:"Move North Star down"});await user.click(down);await waitFor(()=>expect(screen.getByRole("button",{name:/North Star Key:/})).toHaveFocus());expect(screen.getByText("Selected song")).toBeVisible();expect(screen.getByText("North Star moved to position 2 of 3")).toBeInTheDocument();});
});

describe("live stage-lead accessibility",()=>{
  it("makes the current song distinct, retains focus, and announces queue changes",async()=>{const user=userEvent.setup();render(<LiveWorkspace/>);expect(screen.getByText("Current song")).toBeVisible();expect(screen.getByRole("heading",{name:"North Star"})).toBeVisible();await user.click(screen.getByRole("button",{name:"Make Open Road current"}));const heading=screen.getByRole("heading",{name:"Open Road"});expect(heading).toBeVisible();await waitFor(()=>expect(heading).toHaveFocus());expect(screen.getByRole("status")).toHaveTextContent("Open Road is now current");});
  it("does not record a queue move as a completed performance and prevents duplicate perform actions",async()=>{const user=userEvent.setup();render(<LiveWorkspace/>);await user.click(screen.getByText("Performance history"));await user.click(screen.getByRole("button",{name:"Make Open Road current"}));expect(screen.getByText("No completed songs yet.")).toBeVisible();const performed=screen.getByRole("button",{name:"Mark performed"});await user.click(performed);expect(performed).toBeDisabled();});
  it("shows offline authority, freshness, delayed work, and handoff state explicitly",()=>{render(<LiveWorkspace initialOffline/>);expect(screen.getByText("Offline lease active")).toBeVisible();expect(screen.getByText(/last confirmed/i)).toBeVisible();expect(screen.getByText(/1 delayed change/i)).toBeVisible();expect(screen.getByRole("button",{name:"Hand off stage lead"})).toBeEnabled();});
});

describe("rehearsal coordination accessibility",()=>{
  it("keeps selected arrangement context obvious and supports assignment/readiness workflow by keyboard",async()=>{const user=userEvent.setup();render(<RehearsalWorkspace/>);const second=screen.getByRole("button",{name:/Open Road arrangement/});await user.tab();while(document.activeElement!==second)await user.tab();await user.keyboard("{Enter}");expect(screen.getByRole("heading",{name:"Open Road"})).toBeVisible();expect(screen.getByText("Selected arrangement")).toBeVisible();await user.click(screen.getByRole("button",{name:"Offer lead vocal to Avery"}));expect(screen.getByRole("status")).toHaveTextContent("Offer sent to Avery");expect(screen.getByRole("button",{name:"Mark lead vocal rehearsal-ready"})).toBeEnabled();});
});
