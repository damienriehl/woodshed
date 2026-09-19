import { createRequire } from "node:module";
import type { createApi as CreateApiType } from "../../api-node/src/app.ts";
import type { ChoiceService as ChoiceServiceType } from "../../../packages/application/src/choice-service.ts";
// Native loading preserves migration file URLs and shares ChoiceError identity with the server.
const nativeRequire = createRequire(`${process.cwd()}/package.json`);
const { createApi } = nativeRequire("../api-node/src/app.ts") as { createApi: typeof CreateApiType };
const { ChoiceService } = nativeRequire("../../packages/application/src/choice-service.ts") as { ChoiceService: typeof ChoiceServiceType };
import "@testing-library/jest-dom/vitest";
import { act,render,screen,waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe,expect,it,vi } from "vitest";
import { App, LiveWorkspace, ProposalForm, RankedBallot, RehearsalWorkspace } from "./App.tsx";
import { ApiError, createWoodshedApi, type WoodshedApi } from "./api.ts";

function connectedApi(overrides: Partial<WoodshedApi> = {}): WoodshedApi {
  return {
    discover: async () => ({ events: [{ id: "event_public", name: "Summer Singalong", state: "voting", visibility: "public", participationPolicy: "open" }] }),
    activeEvents: async () => ({ events: [] }),
    eventContext: async (eventId) => ({ event: { id:eventId,name:"Invited Event",state:"voting",visibility:"unlisted",participationPolicy:"invite" } }),
    joinOpen: async () => ({ assurance: "open-public" }),
    recover:async()=>{throw new ApiError(401,"unauthorized")},
    ballot: async () => ({ method: "ranked-choice", revision: 2, candidates: [{ id: "song_alpha", title: "North Star" }, { id: "song_bravo", title: "Open Road" }] }),
    saveBallot: async (_eventId, input) => ({ method: "ranked-choice", revision: input.expectedRevision + 1, rankings: input.rankings }),
    propose: async (_eventId, input) => ({ id: "proposal_demo", title: input.title, state: "submitted" }),
    logout: async () => {},
    ...overrides,
  };
}

describe("ranked ballot accessibility",()=>{
  it("provides keyboard-operable reorder controls, selection context, and focus retention",async()=>{const user=userEvent.setup();render(<RankedBallot/>);const down=screen.getByRole("button",{name:"Move North Star down"});await user.click(down);await waitFor(()=>expect(screen.getByRole("button",{name:/North Star Key:/})).toHaveFocus());expect(screen.getByText("Selected song")).toBeVisible();expect(screen.getByText("North Star moved to position 2 of 3")).toBeInTheDocument();});
  it("labels local demo state and confirms a demo save",async()=>{const user=userEvent.setup();render(<RankedBallot/>);await user.click(screen.getByRole("button",{name:"Move North Star down"}));expect(screen.getByText("Unsaved demo changes")).toBeVisible();await user.click(screen.getByRole("button",{name:"Save ranked ballot"}));expect(screen.getByText("Demo saved in this tab")).toBeVisible();expect(screen.getByText(/reset on refresh/)).toBeInTheDocument();});
  it("keeps one uneditable save in flight and reuses its operation id after an ambiguous failure",async()=>{const user=userEvent.setup();let rejectFirst:((reason?:unknown)=>void)|undefined;const first=new Promise<number>((_resolve,reject)=>{rejectFirst=reject});const save=vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(1);render(<RankedBallot onSave={save}/>);const button=screen.getByRole("button",{name:"Save ranked ballot"});await user.click(button);expect(screen.getByRole("button",{name:"Saving ballot…"})).toBeDisabled();expect(screen.getByRole("button",{name:"Move North Star down"})).toBeDisabled();await user.click(screen.getByRole("button",{name:"Saving ballot…"}));expect(save).toHaveBeenCalledTimes(1);rejectFirst?.(new Error("response lost"));expect(await screen.findByText("Save failed · try again")).toBeVisible();await user.click(screen.getByRole("button",{name:"Save ranked ballot"}));expect(save).toHaveBeenCalledTimes(2);expect(save.mock.calls[1]?.[2]).toBe(save.mock.calls[0]?.[2]);expect(await screen.findByText("Ballot saved · revision 1")).toBeVisible();});
});

describe("API-backed participant choice",()=>{
  it("reuses a proposal operation id after an ambiguous failure",async()=>{const user=userEvent.setup();const submit=vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce("submitted");render(<ProposalForm onSubmit={submit}/>);await user.type(screen.getByRole("textbox",{name:"Song title"}),"Lantern Song");await user.click(screen.getByRole("button",{name:"Send for consideration"}));expect(await screen.findByText("Proposal was not sent. Please try again.")).toBeVisible();await user.click(screen.getByRole("button",{name:"Send for consideration"}));expect(await screen.findByText("Lantern Song sent for organizer review.")).toBeVisible();expect(submit.mock.calls[1]?.[1]).toBe(submit.mock.calls[0]?.[1]);});
  it("joins only after an unauthorized ballot read, then persists ballot and proposal changes",async()=>{const calls:{rankings?:string[];proposal?:string;joins:number;ballots:number}={joins:0,ballots:0};const api=connectedApi({joinOpen:async()=>{calls.joins+=1;return {assurance:"open-public"}},ballot:async()=>{calls.ballots+=1;if(calls.ballots===1)throw new ApiError(401,"unauthorized");return {method:"ranked-choice",revision:2,candidates:[{id:"song_alpha",title:"North Star"},{id:"song_bravo",title:"Open Road"}]}},saveBallot:async(_eventId,input)=>{calls.rankings=input.rankings;return {method:"ranked-choice",revision:input.expectedRevision+1,rankings:input.rankings}},propose:async(_eventId,input)=>{calls.proposal=input.title;return {id:"proposal_demo",title:input.title,state:"submitted"}}});const user=userEvent.setup();render(<App api={api}/>);expect(await screen.findByText("Open public participation")).toBeVisible();expect(calls).toMatchObject({joins:1,ballots:2});expect(await screen.findByRole("button",{name:/Move North Star down/})).toBeEnabled();await user.click(screen.getByRole("button",{name:"Move North Star down"}));await user.click(screen.getByRole("button",{name:"Save ranked ballot"}));expect(await screen.findByText("Ballot saved · revision 3")).toBeVisible();expect(calls.rankings).toEqual(["song_bravo","song_alpha"]);await user.type(screen.getByRole("textbox",{name:"Song title"}),"Lantern Song");await user.click(screen.getByRole("button",{name:"Send for consideration"}));expect(await screen.findByText("Lantern Song sent for organizer review.")).toBeVisible();expect(calls.proposal).toBe("Lantern Song");});
  it("surfaces API failure without falling back to pretend persistence",async()=>{const api=connectedApi({discover:async()=>{throw new Error("offline")}});render(<App api={api}/>);expect(await screen.findByRole("alert")).toHaveTextContent("Participant services are unavailable");expect(screen.queryByText("Example participation state")).not.toBeInTheDocument();});
  it("keeps rehearsal and live actions explicitly synthetic",async()=>{const user=userEvent.setup();render(<App api={connectedApi()}/>);await screen.findByText("Open public participation");await user.click(screen.getByText("Schedule a rehearsal"));await user.click(screen.getByRole("button",{name:"Publish rehearsal"}));expect(screen.getByText(/No calendar update was sent/)).toBeVisible();expect(screen.getByText("Demo connection available")).toBeVisible();});
  it("does not apply a delayed save to a newly selected event",async()=>{let resolveSave:((value:{method:"ranked-choice";revision:number;rankings:string[]})=>void)|undefined;const api=connectedApi({discover:async()=>({events:[{id:"event_a",name:"First Event",state:"voting",visibility:"public",participationPolicy:"open"},{id:"event_b",name:"Second Event",state:"voting",visibility:"public",participationPolicy:"open"}]}),ballot:async eventId=>({method:"ranked-choice",revision:0,candidates:[{id:eventId==="event_a"?"song_alpha":"song_bravo",title:eventId==="event_a"?"North Star":"Open Road"}]}),saveBallot:async()=>new Promise(resolve=>{resolveSave=resolve})});const user=userEvent.setup();render(<App api={api}/>);await screen.findByRole("button",{name:"Save ranked ballot"});await user.click(screen.getByRole("button",{name:"Save ranked ballot"}));await user.selectOptions(screen.getByLabelText("Current event"),"event_b");await screen.findByRole("button",{name:"Save ranked ballot"});resolveSave?.({method:"ranked-choice",revision:1,rankings:["song_alpha"]});await waitFor(()=>expect(screen.getByRole("button",{name:/Open Road Eligible/})).toBeVisible());expect(screen.queryByRole("button",{name:/North Star Eligible/})).not.toBeInTheDocument();});
  it("ignores a delayed save after switching away from and back to the same event",async()=>{let resolveOld:((value:{method:"ranked-choice";revision:number;rankings:string[]})=>void)|undefined;let aReads=0;const revisions:number[]=[];const api=connectedApi({discover:async()=>({events:[{id:"event_a",name:"First Event",state:"voting",visibility:"public",participationPolicy:"open"},{id:"event_b",name:"Second Event",state:"voting",visibility:"public",participationPolicy:"open"}]}),ballot:async eventId=>eventId==="event_b"?{method:"ranked-choice",revision:0,candidates:[{id:"song_bravo",title:"Open Road"}]}:(aReads++===0?{method:"ranked-choice",revision:0,candidates:[{id:"song_alpha",title:"North Star"}]}:{method:"ranked-choice",revision:2,candidates:[{id:"song_charlie",title:"Quiet River"}]}),saveBallot:async(_eventId,input)=>{revisions.push(input.expectedRevision);if(revisions.length===1)return new Promise(resolve=>{resolveOld=resolve});return {method:"ranked-choice",revision:3,rankings:input.rankings}}});const user=userEvent.setup();render(<App api={api}/>);await screen.findByRole("button",{name:/North Star Eligible/});await user.click(screen.getByRole("button",{name:"Save ranked ballot"}));await user.selectOptions(screen.getByLabelText("Current event"),"event_b");await screen.findByRole("button",{name:/Open Road Eligible/});await user.selectOptions(screen.getByLabelText("Current event"),"event_a");await screen.findByRole("button",{name:/Quiet River Eligible/});await user.click(screen.getByRole("button",{name:"Save ranked ballot"}));expect(await screen.findByText("Ballot saved · revision 3")).toBeVisible();resolveOld?.({method:"ranked-choice",revision:1,rankings:["song_alpha"]});await waitFor(()=>expect(screen.getByRole("button",{name:/Quiet River Eligible/})).toBeVisible());expect(revisions).toEqual([0,2]);});
  it("hides a retained ballot until a revisited event reloads",async()=>{let resolveReload:((value:{method:"ranked-choice";revision:number;candidates:{id:string;title:string}[]})=>void)|undefined;let aReads=0;const api=connectedApi({discover:async()=>({events:[{id:"event_a",name:"First Event",state:"voting",visibility:"public",participationPolicy:"open"},{id:"event_b",name:"Second Event",state:"voting",visibility:"public",participationPolicy:"open"}]}),ballot:async eventId=>{if(eventId==="event_b")return {method:"ranked-choice",revision:0,candidates:[{id:"song_bravo",title:"Open Road"}]};if(aReads++===0)return {method:"ranked-choice",revision:1,candidates:[{id:"song_alpha",title:"North Star"}]};return new Promise(resolve=>{resolveReload=resolve})}});const user=userEvent.setup();render(<App api={api}/>);await screen.findByRole("button",{name:/North Star Eligible/});await user.selectOptions(screen.getByLabelText("Current event"),"event_b");await screen.findByRole("button",{name:/Open Road Eligible/});await user.selectOptions(screen.getByLabelText("Current event"),"event_a");expect(screen.queryByRole("button",{name:"Save ranked ballot"})).not.toBeInTheDocument();resolveReload?.({method:"ranked-choice",revision:2,candidates:[{id:"song_charlie",title:"Quiet River"}]});expect(await screen.findByRole("button",{name:/Quiet River Eligible/})).toBeVisible();});
  it("does not carry an in-flight proposal into a newly selected event",async()=>{let resolveProposal:((value:{id:string;title:string;state:"submitted"})=>void)|undefined;const api=connectedApi({discover:async()=>({events:[{id:"event_a",name:"First Event",state:"voting",visibility:"public",participationPolicy:"open"},{id:"event_b",name:"Second Event",state:"voting",visibility:"public",participationPolicy:"open"}]}),ballot:async eventId=>({method:"ranked-choice",revision:0,candidates:[{id:`song_${eventId}`,title:`Song ${eventId}`}]}),propose:async(_eventId,input)=>new Promise(resolve=>{resolveProposal=value=>resolve({...value,title:input.title})})});const user=userEvent.setup();render(<App api={api}/>);const title=await screen.findByRole("textbox",{name:"Song title"});await user.type(title,"Old Event Song");await user.click(screen.getByRole("button",{name:"Send for consideration"}));await user.selectOptions(screen.getByLabelText("Current event"),"event_b");const newTitle=await screen.findByRole("textbox",{name:"Song title"});expect(newTitle).toHaveValue("");resolveProposal?.({id:"proposal_old",title:"Old Event Song",state:"submitted"});await waitFor(()=>expect(screen.queryByText("Old Event Song sent for organizer review.")).not.toBeInTheDocument());});
  it("replaces an event-scoped session when another open event returns forbidden",async()=>{let current="event_a";const joins:string[]=[];const api=connectedApi({discover:async()=>({events:[{id:"event_a",name:"First Event",state:"voting",visibility:"public",participationPolicy:"open"},{id:"event_b",name:"Second Event",state:"voting",visibility:"public",participationPolicy:"open"}]}),ballot:async eventId=>{if(eventId!==current)throw new ApiError(403,"denied");return {method:"ranked-choice",revision:0,candidates:[{id:eventId==="event_a"?"song_alpha":"song_bravo",title:eventId==="event_a"?"North Star":"Open Road"}]};},joinOpen:async eventId=>{current=eventId;joins.push(eventId);return {assurance:"open-public"}}});const user=userEvent.setup();render(<App api={api}/>);await screen.findByRole("button",{name:/North Star Eligible/});await user.selectOptions(screen.getByLabelText("Current event"),"event_b");expect(await screen.findByRole("button",{name:/Open Road Eligible/})).toBeVisible();expect(joins).toEqual(["event_b"]);});
  it("reloads the canonical ballot after a definitive revision conflict",async()=>{let reads=0;const saves:number[]=[];const api=connectedApi({ballot:async()=>{reads+=1;return reads===1?{method:"ranked-choice",revision:2,candidates:[{id:"song_alpha",title:"North Star"},{id:"song_bravo",title:"Open Road"}]}:{method:"ranked-choice",revision:3,candidates:[{id:"song_bravo",title:"Open Road"},{id:"song_alpha",title:"North Star"}]}},saveBallot:async(_eventId,input)=>{saves.push(input.expectedRevision);if(saves.length===1)throw new ApiError(409,"conflict");return {method:"ranked-choice",revision:4,rankings:input.rankings}}});const user=userEvent.setup();render(<App api={api}/>);await screen.findByRole("button",{name:/Move North Star down/});await user.click(screen.getByRole("button",{name:"Save ranked ballot"}));expect(await screen.findByText("Ballot changed elsewhere · refreshed to revision 3")).toBeVisible();expect(screen.getByRole("button",{name:/Open Road Eligible/})).toBeVisible();await user.click(screen.getByRole("button",{name:"Save ranked ballot"}));expect(await screen.findByText("Ballot saved · revision 4")).toBeVisible();expect(saves).toEqual([2,3]);});
  it("transitions an already-open ballot to closed when the server closes voting",async()=>{const ballot=vi.fn().mockResolvedValue({method:"ranked-choice",revision:2,candidates:[{id:"song_alpha",title:"North Star"}]});const api=connectedApi({ballot,saveBallot:async()=>{throw new ApiError(409,"voting-closed")}});const user=userEvent.setup();render(<App api={api}/>);await screen.findByRole("button",{name:"Save ranked ballot"});await user.click(screen.getByRole("button",{name:"Save ranked ballot"}));expect(await screen.findByText("Voting is closed")).toBeVisible();expect(screen.getByText("This event is visible, but it is not accepting ballots right now.")).toBeVisible();expect(screen.queryByRole("button",{name:"Save ranked ballot"})).not.toBeInTheDocument();expect(ballot).toHaveBeenCalledTimes(1);});
  it("selects an invited unlisted event from the redirect path",async()=>{window.history.pushState({},"","/events/event_invited");try{const api=connectedApi({discover:async()=>({events:[{id:"event_public",name:"Public Event",state:"voting",visibility:"public",participationPolicy:"open"}]}),eventContext:async()=>({event:{id:"event_invited",name:"Invited Workshop",state:"voting",visibility:"unlisted",participationPolicy:"invite"}}),ballot:async eventId=>({method:"ranked-choice",revision:0,candidates:[{id:"song_invited",title:`Song for ${eventId}`} ]})});render(<App api={api}/>);expect(await screen.findByRole("heading",{name:"Invited Workshop"})).toBeVisible();expect(await screen.findByText("Invite confirmed")).toBeVisible();expect(screen.getByText("Your invite session is active for this event.")).toBeVisible();expect(await screen.findByRole("button",{name:/Song for event_invited Eligible/})).toBeVisible();}finally{window.history.pushState({},"","/")}});
  it("recovers an expired invite session before declaring the invite unusable",async()=>{let reads=0;const recover=vi.fn().mockResolvedValue({assurance:"invite"});const api=connectedApi({discover:async()=>({events:[{id:"event_invited",name:"Invited Workshop",state:"voting",visibility:"unlisted",participationPolicy:"invite"}]}),ballot:async()=>{if(reads++===0)throw new ApiError(401,"unauthorized");return {method:"ranked-choice",revision:1,candidates:[{id:"song_invited",title:"Invite Song"}]}},recover});render(<App api={api}/>);expect(await screen.findByText("Invite confirmed")).toBeVisible();expect(recover).toHaveBeenCalledWith("event_invited");expect(screen.getByRole("button",{name:/Invite Song Eligible/})).toBeVisible();});
  it("keeps an active unlisted invite reachable from the home route",async()=>{const api=connectedApi({activeEvents:async()=>({events:[{id:"event_invited",name:"Invited Workshop",state:"voting",visibility:"unlisted",participationPolicy:"invite"}]}),ballot:async eventId=>({method:"ranked-choice",revision:0,candidates:[{id:`song_${eventId}`,title:`Song ${eventId}`} ]})});const user=userEvent.setup();render(<App api={api}/>);expect(await screen.findByRole("button",{name:/Invited Workshop Voting open · unlisted/})).toBeVisible();await user.selectOptions(screen.getByLabelText("Current event"),"event_invited");expect(await screen.findByText("Invite confirmed")).toBeVisible();expect(screen.getByRole("button",{name:/Song event_invited Eligible/})).toBeVisible();});
  it("reports a completed discovery with no available events",async()=>{render(<App api={connectedApi({discover:async()=>({events:[]})})}/>);expect(await screen.findByText("No events are currently available.")).toBeVisible();expect(screen.getByText("No events available")).toBeVisible();expect(screen.queryByText("Loading events…")).not.toBeInTheDocument();});
  it("shows historical public events without joining or exposing a ballot",async()=>{const ballot=vi.fn(),joinOpen=vi.fn();render(<App api={connectedApi({discover:async()=>({events:[{id:"event_complete",name:"Finished Singalong",state:"completed",visibility:"public",participationPolicy:"open"}]}),ballot,joinOpen})}/>);expect(await screen.findByText("Voting is closed")).toBeVisible();expect(screen.getByText("This event is visible, but it is not accepting ballots right now.")).toBeVisible();expect(screen.queryByRole("button",{name:"Save ranked ballot"})).not.toBeInTheDocument();expect(ballot).not.toHaveBeenCalled();expect(joinOpen).not.toHaveBeenCalled();});
  it("shows voting closed when lifecycle changes during the initial ballot read",async()=>{render(<App api={connectedApi({ballot:async()=>{throw new ApiError(409,"voting-closed")}})}/>);expect(await screen.findByText("Voting is closed")).toBeVisible();expect(screen.queryByRole("alert")).not.toBeInTheDocument();expect(screen.queryByRole("button",{name:"Save ranked ballot"})).not.toBeInTheDocument();});
  it("describes proposal handling truthfully for either organizer policy",async()=>{render(<App api={connectedApi()}/>);expect(await screen.findByText(/proposals enter voting immediately or wait for organizer review/)).toBeVisible();});
});

describe("live stage-lead accessibility",()=>{
  it("makes the current song distinct, retains focus, and announces queue changes",async()=>{const user=userEvent.setup();render(<LiveWorkspace/>);expect(screen.getByText("Current song")).toBeVisible();expect(screen.getByRole("heading",{name:"North Star"})).toBeVisible();await user.click(screen.getByRole("button",{name:"Make Open Road current"}));const heading=screen.getByRole("heading",{name:"Open Road"});expect(heading).toBeVisible();await waitFor(()=>expect(heading).toHaveFocus());expect(screen.getByRole("status")).toHaveTextContent("Open Road is now current");});
  it("does not record a queue move as a completed performance and prevents duplicate perform actions",async()=>{const user=userEvent.setup();render(<LiveWorkspace/>);await user.click(screen.getByText("Performance history"));await user.click(screen.getByRole("button",{name:"Make Open Road current"}));expect(screen.getByText("No completed songs yet.")).toBeVisible();const performed=screen.getByRole("button",{name:"Mark performed"});await user.click(performed);expect(performed).toBeDisabled();});
  it("shows simulated offline authority and handoff state explicitly",()=>{render(<LiveWorkspace initialOffline/>);expect(screen.getByText("Simulated offline state")).toBeVisible();expect(screen.getByText(/example authority epoch/i)).toBeVisible();expect(screen.getByText(/connection unavailable/i)).toBeVisible();expect(screen.getByRole("button",{name:"Hand off stage lead"})).toBeEnabled();});
  it("never claims demo changes reached the server after an offline-to-online transition",async()=>{render(<LiveWorkspace/>);act(()=>window.dispatchEvent(new Event("offline")));expect(screen.getByText("Simulated offline state")).toBeVisible();expect(screen.getByText("Connection unavailable")).toBeVisible();act(()=>window.dispatchEvent(new Event("online")));await waitFor(()=>expect(screen.getByText("Demo state only")).toBeVisible());expect(screen.getByText(/does not send stage-lead changes to the API/)).toBeVisible();expect(screen.queryByText(/everything synced/i)).not.toBeInTheDocument();expect(screen.queryByText(/server confirmed/i)).not.toBeInTheDocument();});
});

describe("rehearsal coordination accessibility",()=>{
  it("keeps selected arrangement context obvious and supports assignment/readiness workflow by keyboard",async()=>{const user=userEvent.setup();render(<RehearsalWorkspace/>);const second=screen.getByRole("button",{name:/Open Road arrangement/});await user.tab();while(document.activeElement!==second)await user.tab();await user.keyboard("{Enter}");expect(screen.getByRole("heading",{name:"Open Road"})).toBeVisible();expect(screen.getByText("Selected arrangement")).toBeVisible();await user.click(screen.getByRole("button",{name:"Offer lead vocal to Avery"}));expect(screen.getByRole("status")).toHaveTextContent("Offer sent to Avery");expect(screen.getByRole("button",{name:"Mark lead vocal rehearsal-ready"})).toBeEnabled();});
});


describe("participant interface with real persistence", () => {
  it("joins, saves a reordered ballot, proposes a song, and reloads the saved order from SQLite", async () => {
    const service = new ChoiceService(":memory:");
    service.migrate();
    service.seedDemo({ publicParticipationPolicy: "open" });
    const origin = "https://woodshed.example";
    const server = createApi(service, { origin });
    const cookies = new Map<string, string>();
    const api = createWoodshedApi(async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("origin", origin);
      headers.set("cookie", [...cookies].map(([key, value]) => `${key}=${value}`).join("; "));
      // jsdom signals cannot cross into Node's native Request constructor.
      const response = await server.request(String(input), { ...init, headers, signal: undefined });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";", 1)[0]!;
        const split = pair.indexOf("=");
        cookies.set(pair.slice(0, split), pair.slice(split + 1));
      }
      return response;
    });
    const user = userEvent.setup();
    let view = render(<App api={api}/>);
    try {
      await screen.findByText("Open public participation");
      const before = await api.ballot("event_public");
      const firstTitle = before.candidates[0]!.title;
      await user.click(screen.getByRole("button", { name: `Move ${firstTitle} down` }));
      await user.click(screen.getByRole("button", { name: "Save ranked ballot" }));
      expect(await screen.findByText("Ballot saved · revision 1")).toBeVisible();
      const savedOrder = before.candidates.map(candidate => candidate.id).reverse();
      expect(service.database.prepare("SELECT current_revision, rankings_json FROM participant_ballots").get()).toMatchObject({ current_revision: 1, rankings_json: JSON.stringify(savedOrder) });
      await user.type(screen.getByRole("textbox", { name: "Song title" }), "  Lantern Song  ");
      await user.click(screen.getByRole("button", { name: "Send for consideration" }));
      expect(await screen.findByText("Lantern Song accepted by this event’s immediate proposal policy.")).toBeVisible();
      expect(service.database.prepare("SELECT title, state FROM choice_proposals").get()).toMatchObject({ title: "Lantern Song", state: "eligible" });
      view.unmount();
      view = render(<App api={api}/>);
      expect(await screen.findByText("Saved · revision 1")).toBeVisible();
      expect((await api.ballot("event_public")).candidates.map(candidate => candidate.id)).toEqual(savedOrder);
      expect(service.database.prepare("SELECT count(*) AS count FROM guest_participations").get()).toMatchObject({ count: 1 });
    } finally { view.unmount(); service.close(); }
  });
});

describe("participant interface edge and error states", () => {
  it("requires an invite after both authentication and recovery fail without joining publicly", async () => {
    const joinOpen = vi.fn();
    render(<App api={connectedApi({ discover: async () => ({ events: [{ id: "event_invited", name: "Invite only", state: "voting", visibility: "unlisted", participationPolicy: "invite" }] }), ballot: async () => { throw new ApiError(401, "unauthorized"); }, joinOpen })}/>);
    expect(await screen.findByText("Open this event through an organizer-provided invite link.")).toBeVisible();
    expect(joinOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Save ranked ballot" })).not.toBeInTheDocument();
  });

  it("reports recovery infrastructure failures without minting a new public identity", async () => {
    const joinOpen = vi.fn();
    render(<App api={connectedApi({ ballot: async () => { throw new ApiError(401, "unauthorized"); }, recover: async () => { throw new ApiError(500, "internal-error"); }, joinOpen })}/>);
    expect(await screen.findByRole("alert")).toHaveTextContent("Participant services are unavailable");
    expect(joinOpen).not.toHaveBeenCalled();
  });

  it("closes voting when recovery reports a lifecycle change", async () => {
    const joinOpen = vi.fn();
    render(<App api={connectedApi({ ballot: async () => { throw new ApiError(401, "unauthorized"); }, recover: async () => { throw new ApiError(409, "voting-closed"); }, joinOpen })}/>);
    expect(await screen.findByText("Voting is closed")).toBeVisible();
    expect(joinOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retains the displayed ballot and explains a failed conflict reconciliation", async () => {
    let reads = 0;
    render(<App api={connectedApi({ ballot: async () => { if (reads++ > 0) throw new Error("offline"); return { method: "ranked-choice", revision: 2, candidates: [{ id: "song_alpha", title: "North Star" }] }; }, saveBallot: async () => { throw new ApiError(409, "conflict"); } })}/>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Save ranked ballot" }));
    expect(await screen.findByText("Ballot changed elsewhere · refresh needed")).toBeVisible();
    expect(screen.getByText("Another tab changed this ballot, but the latest ballot could not be loaded. Refresh before saving again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /North Star Eligible/ })).toBeVisible();
  });

  it("deduplicates public and active discoveries by event id", async () => {
    const base = connectedApi();
    render(<App api={connectedApi({ activeEvents: base.discover })}/>);
    await screen.findByText("Open public participation");
    expect(screen.getAllByRole("option", { name: "Summer Singalong" })).toHaveLength(1);
  });

  it.each([401, 403, 404])("falls back to public discovery when a direct event link returns %s", async status => {
    window.history.pushState({}, "", "/events/event_missing");
    try {
      render(<App api={connectedApi({ eventContext: async () => { throw new ApiError(status, "unavailable"); } })}/>);
      expect(await screen.findByText("Open public participation")).toBeVisible();
      expect(screen.getByRole("heading", { name: "Summer Singalong" })).toBeVisible();
    } finally { window.history.pushState({}, "", "/"); }
  });

  it("surfaces direct-link infrastructure failure", async () => {
    window.history.pushState({}, "", "/events/event_missing");
    try {
      render(<App api={connectedApi({ eventContext: async () => { throw new ApiError(500, "internal-error"); } })}/>);
      expect(await screen.findByRole("alert")).toHaveTextContent("Participant services are unavailable");
    } finally { window.history.pushState({}, "", "/"); }
  });

  it("rejects whitespace-only proposals and generates a new operation after editing a failed title", async () => {
    const submit = vi.fn().mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(<ProposalForm onSubmit={submit}/>);
    const input = screen.getByRole("textbox", { name: "Song title" });
    await user.type(input, "   ");
    await user.click(screen.getByRole("button", { name: "Send for consideration" }));
    expect(submit).not.toHaveBeenCalled();
    await user.type(input, "First Song  ");
    await user.click(screen.getByRole("button", { name: "Send for consideration" }));
    await screen.findByText("Proposal was not sent. Please try again.");
    await user.clear(input);
    await user.type(input, "Second Song");
    await user.click(screen.getByRole("button", { name: "Send for consideration" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[0]?.[0]).toBe("First Song");
    expect(submit.mock.calls[1]?.[1]).not.toBe(submit.mock.calls[0]?.[1]);
  });

  it("saves an empty eligible-song list without manufacturing candidates", async () => {
    const save = vi.fn().mockResolvedValue(1);
    const user = userEvent.setup();
    render(<RankedBallot initial={[]} revision={0} onSave={save}/>);
    expect(screen.queryByRole("group", { name: /Move/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save ranked ballot" }));
    expect(await screen.findByText("Ballot saved · revision 1")).toBeVisible();
    expect(save).toHaveBeenCalledWith([], 0, expect.stringMatching(/^ballot_/));
  });
});


describe("proposal and demo action boundaries", () => {
  it("disables proposal editing and duplicate submits until the request settles", async () => {
    let resolve: ((value: "eligible") => void) | undefined;
    const submit = vi.fn(() => new Promise<"eligible">(done => { resolve = done; }));
    const user = userEvent.setup();
    render(<ProposalForm onSubmit={submit}/>);
    const input = screen.getByRole("textbox", { name: "Song title" });
    await user.type(input, "Lantern Song");
    await user.click(screen.getByRole("button", { name: "Send for consideration" }));
    expect(input).toBeDisabled();
    const sending = screen.getByRole("button", { name: "Sending…" });
    expect(sending).toBeDisabled();
    await user.click(sending);
    expect(submit).toHaveBeenCalledTimes(1);
    await act(async () => resolve?.("eligible"));
    expect(await screen.findByText("Lantern Song accepted by this event’s immediate proposal policy.")).toBeVisible();
    expect(input).toBeEnabled();
    expect(input).toHaveValue("");
  });

  it("allocates a new ballot operation when rankings change after an ambiguous failure", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce(1);
    const user = userEvent.setup();
    render(<RankedBallot onSave={save}/>);
    await user.click(screen.getByRole("button", { name: "Save ranked ballot" }));
    await screen.findByText("Save failed · try again");
    await user.click(screen.getByRole("button", { name: "Move North Star down" }));
    await user.click(screen.getByRole("button", { name: "Save ranked ballot" }));
    await screen.findByText("Ballot saved · revision 1");
    expect(save.mock.calls[1]?.[0]).toEqual(["song_bravo", "song_alpha", "song_charlie"]);
    expect(save.mock.calls[1]?.[2]).not.toBe(save.mock.calls[0]?.[2]);
  });

  it("announces a simulated proposal and clears its input", async () => {
    const user = userEvent.setup();
    render(<ProposalForm/>);
    const input = screen.getByRole("textbox", { name: "Song title" });
    await user.type(input, "Demo Song");
    await user.click(screen.getByRole("button", { name: "Send for consideration" }));
    expect(screen.getByRole("status")).toHaveTextContent("Demo Song submission simulated. Nothing was queued or sent.");
    expect(input).toHaveValue("");
  });

  it("cancels a simulated handoff and keeps device clearing explicitly synthetic", async () => {
    const user = userEvent.setup();
    render(<LiveWorkspace/>);
    await user.click(screen.getByRole("button", { name: "Hand off stage lead" }));
    expect(screen.getByText("Simulated handoff pending")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Handoff simulation opened; no server request was sent");
    await user.click(screen.getByRole("button", { name: "Cancel handoff" }));
    expect(screen.queryByText("Simulated handoff pending")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Handoff simulation cancelled");
    await user.click(screen.getByRole("button", { name: "Clear this device" }));
    expect(screen.getByRole("status")).toHaveTextContent("Clear-device action simulated; no persistent event data exists");
  });

  it("resets arrangement-specific offer controls after changing the selected arrangement", async () => {
    const user = userEvent.setup();
    render(<RehearsalWorkspace/>);
    await user.click(screen.getByRole("button", { name: "Offer lead vocal to Avery" }));
    await user.click(screen.getByRole("button", { name: "Mark lead vocal rehearsal-ready" }));
    expect(screen.getByRole("status")).toHaveTextContent("Lead vocal marked rehearsal-ready");
    await user.click(screen.getByRole("button", { name: "Open Road arrangement" }));
    expect(screen.getByRole("button", { name: "Offer lead vocal to Avery" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Mark lead vocal rehearsal-ready" })).not.toBeInTheDocument();
  });
});
