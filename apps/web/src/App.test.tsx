import "@testing-library/jest-dom/vitest";
import { render,screen,waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe,expect,it } from "vitest";
import { RankedBallot } from "./App.tsx";

describe("ranked ballot accessibility",()=>{
  it("provides keyboard-operable reorder controls, selection context, and focus retention",async()=>{const user=userEvent.setup();render(<RankedBallot/>);const down=screen.getByRole("button",{name:"Move North Star down"});await user.click(down);await waitFor(()=>expect(screen.getByRole("button",{name:/North Star Key:/})).toHaveFocus());expect(screen.getByText("Selected song")).toBeVisible();expect(screen.getByText("North Star moved to position 2 of 3")).toBeInTheDocument();});
});
