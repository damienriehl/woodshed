import "@testing-library/jest-dom/vitest";
import { render,screen,waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe,expect,it } from "vitest";
import { App, LiveWorkspace, RankedBallot, RehearsalWorkspace } from "./App.tsx";

describe("ranked ballot accessibility",()=>{
  it("provides keyboard-operable reorder controls, selection context, and focus retention",async()=>{const user=userEvent.setup();render(<RankedBallot/>);const down=screen.getByRole("button",{name:"Move North Star down"});await user.click(down);await waitFor(()=>expect(screen.getByRole("button",{name:/North Star Key:/})).toHaveFocus());expect(screen.getByText("Selected song")).toBeVisible();expect(screen.getByText("North Star moved to position 2 of 3")).toBeInTheDocument();});
  it("labels local demo state and confirms a demo save",async()=>{const user=userEvent.setup();render(<RankedBallot/>);await user.click(screen.getByRole("button",{name:"Move North Star down"}));expect(screen.getByText("Unsaved demo changes")).toBeVisible();await user.click(screen.getByRole("button",{name:"Save ranked ballot"}));expect(screen.getByText("Demo saved in this tab")).toBeVisible();expect(screen.getByText(/reset on refresh/)).toBeInTheDocument();});
});

describe("prototype truth",()=>{it("explains synthetic persistence and confirms a local proposal",async()=>{const user=userEvent.setup();render(<App/>);expect(screen.getByText("Interactive prototype")).toBeVisible();expect(screen.getByText(/not sent to the API/)).toBeVisible();await user.type(screen.getByRole("textbox",{name:"Song title"}),"Lantern Song");await user.click(screen.getByRole("button",{name:"Send for consideration"}));expect(screen.getByText(/Lantern Song queued in this demo tab/)).toBeVisible();});});

describe("live stage-lead accessibility",()=>{
  it("makes the current song distinct, retains focus, and announces queue changes",async()=>{const user=userEvent.setup();render(<LiveWorkspace/>);expect(screen.getByText("Current song")).toBeVisible();expect(screen.getByRole("heading",{name:"North Star"})).toBeVisible();await user.click(screen.getByRole("button",{name:"Make Open Road current"}));const heading=screen.getByRole("heading",{name:"Open Road"});expect(heading).toBeVisible();await waitFor(()=>expect(heading).toHaveFocus());expect(screen.getByRole("status")).toHaveTextContent("Open Road is now current");});
  it("does not record a queue move as a completed performance and prevents duplicate perform actions",async()=>{const user=userEvent.setup();render(<LiveWorkspace/>);await user.click(screen.getByText("Performance history"));await user.click(screen.getByRole("button",{name:"Make Open Road current"}));expect(screen.getByText("No completed songs yet.")).toBeVisible();const performed=screen.getByRole("button",{name:"Mark performed"});await user.click(performed);expect(performed).toBeDisabled();});
  it("shows offline authority, freshness, delayed work, and handoff state explicitly",()=>{render(<LiveWorkspace initialOffline/>);expect(screen.getByText("Offline lease active")).toBeVisible();expect(screen.getByText(/last confirmed/i)).toBeVisible();expect(screen.getByText(/connection unavailable/i)).toBeVisible();expect(screen.getByRole("button",{name:"Hand off stage lead"})).toBeEnabled();});
  it("never claims demo changes reached the server after reconnecting",()=>{render(<LiveWorkspace/>);expect(screen.getByText("Demo state only")).toBeVisible();expect(screen.getByText(/does not send stage-lead changes to the API/)).toBeVisible();expect(screen.queryByText(/everything synced/i)).not.toBeInTheDocument();expect(screen.queryByText(/server confirmed/i)).not.toBeInTheDocument();});
});

describe("rehearsal coordination accessibility",()=>{
  it("keeps selected arrangement context obvious and supports assignment/readiness workflow by keyboard",async()=>{const user=userEvent.setup();render(<RehearsalWorkspace/>);const second=screen.getByRole("button",{name:/Open Road arrangement/});await user.tab();while(document.activeElement!==second)await user.tab();await user.keyboard("{Enter}");expect(screen.getByRole("heading",{name:"Open Road"})).toBeVisible();expect(screen.getByText("Selected arrangement")).toBeVisible();await user.click(screen.getByRole("button",{name:"Offer lead vocal to Avery"}));expect(screen.getByRole("status")).toHaveTextContent("Offer sent to Avery");expect(screen.getByRole("button",{name:"Mark lead vocal rehearsal-ready"})).toBeEnabled();});
});
