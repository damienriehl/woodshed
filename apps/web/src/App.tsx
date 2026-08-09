import { useRef, useState } from "react";

export type Candidate = { id:string; title:string; detail:string };
const INITIAL: Candidate[] = [
  {id:"song_alpha",title:"North Star",detail:"Key: C · Readiness unknown"},
  {id:"song_bravo",title:"Open Road",detail:"Key: G · Ready for rehearsal"},
  {id:"song_charlie",title:"Quiet River",detail:"Key: D · Arrangement pending"},
];
const EVENTS = [
  { id: "event_public", name: "Summer Singalong", status: "Voting open", visibility: "Public", entry: "Invite required" },
  { id: "event_unlisted", name: "Band Workshop", status: "Published", visibility: "Unlisted", entry: "Invite required" },
] as const;

export function RankedBallot({initial=INITIAL}:{initial?:Candidate[]}) {
  const [songs,setSongs]=useState(initial); const [selected,setSelected]=useState(initial[0]?.id); const [announcement,setAnnouncement]=useState(""); const buttons=useRef(new Map<string,HTMLButtonElement>());
  function move(index:number,delta:number){const next=index+delta;if(next<0||next>=songs.length)return;const copy=[...songs];const [item]=copy.splice(index,1);if(!item)return;copy.splice(next,0,item);setSongs(copy);setSelected(item.id);setAnnouncement(`${item.title} moved to position ${next+1} of ${copy.length}`);requestAnimationFrame(()=>buttons.current.get(item.id)?.focus());}
  return <section aria-labelledby="ballot-heading" className="panel">
    <div className="section-heading"><div><span className="eyebrow">Your ballot</span><h2 id="ballot-heading">Rank the songs you want to hear</h2></div><span className="save-state">Saved locally</span></div>
    <p className="hint">Your order is private. Use the buttons or keyboard to change it; number 1 is your top choice.</p><p className="sr-only" aria-live="polite">{announcement}</p>
    <ol className="rank-list">{songs.map((song,index)=><li key={song.id} className={selected===song.id?"song-card selected":"song-card"}>
      <span className="rank" aria-hidden="true">{index+1}</span><button ref={node=>{if(node)buttons.current.set(song.id,node)}} className="song-select" onClick={()=>setSelected(song.id)} aria-pressed={selected===song.id}><strong>{song.title}</strong><span>{song.detail}</span></button>
      <div className="move-actions" role="group" aria-label={`Move ${song.title}`}><button onClick={()=>move(index,-1)} disabled={index===0} aria-label={`Move ${song.title} up`}>↑</button><button onClick={()=>move(index,1)} disabled={index===songs.length-1} aria-label={`Move ${song.title} down`}>↓</button></div>
      {selected===song.id&&<div className="selected-context"><span>Selected song</span><dl><div><dt>Ballot position</dt><dd>{index+1} of {songs.length}</dd></div><div><dt>Availability</dt><dd>Eligible for this event</dd></div></dl></div>}
    </li>)}</ol><button className="primary">Save ranked ballot</button>
  </section>;
}

const ARRANGEMENTS=[
  {id:"arrangement_north",title:"North Star",key:"C",revision:2,parts:[{id:"lead",name:"Lead vocal",performer:"Avery",state:"Volunteer",readiness:"Learning"},{id:"drums",name:"Drums",performer:"Jordan",state:"Assigned",readiness:"Rehearsal-ready"}]},
  {id:"arrangement_road",title:"Open Road",key:"G",revision:1,parts:[{id:"lead",name:"Lead vocal",performer:"Avery",state:"Volunteer",readiness:"Interested"},{id:"guitar",name:"Lead guitar",performer:"Morgan",state:"Backup accepted",readiness:"Learning"}]},
] as const;

export function RehearsalWorkspace(){
  const [selected,setSelected]=useState(ARRANGEMENTS[0].id);const [message,setMessage]=useState("");const [offered,setOffered]=useState(false);const current=ARRANGEMENTS.find(item=>item.id===selected)??ARRANGEMENTS[0];
  return <section className="panel coordination" aria-labelledby="staffing-heading"><div className="section-heading"><div><span className="eyebrow">Staff & rehearse</span><h2 id="staffing-heading">Prepare the selected repertoire</h2></div><span className="save-state">Provider-independent</span></div><p className="hint">Volunteer interest stays separate from confirmed assignments. Arrangement changes only reset the readiness they affect.</p>
    <div className="coordination-layout"><div className="arrangement-list" role="group" aria-label="Event arrangements">{ARRANGEMENTS.map(item=><button key={item.id} aria-label={`${item.title} arrangement`} aria-pressed={selected===item.id} className={selected===item.id?"arrangement-card selected":"arrangement-card"} onClick={()=>{setSelected(item.id);setMessage(`${item.title} selected`);setOffered(false)}}><strong>{item.title}</strong><span>Key {item.key} · {item.parts.length} parts</span></button>)}</div>
      <article className="arrangement-focus" aria-labelledby="selected-arrangement"><span className="eyebrow">Selected arrangement</span><h3 id="selected-arrangement">{current.title}</h3><dl className="attribute-strip"><div><dt>Key</dt><dd>{current.key}</dd></div><div><dt>Decision</dt><dd>Version {current.revision}</dd></div><div><dt>Required parts</dt><dd>{current.parts.length}</dd></div></dl>
        <ul className="part-list">{current.parts.map(part=><li key={part.id}><div><strong>{part.name}</strong><span>{part.performer} · {part.state}</span></div><span className="readiness">{part.readiness}</span>{part.id==="lead"&&!offered?<button onClick={()=>{setOffered(true);setMessage(`Offer sent to ${part.performer}`)}} aria-label={`Offer ${part.name.toLowerCase()} to ${part.performer}`}>Send offer</button>:part.id==="lead"?<button onClick={()=>setMessage(`${part.name} marked rehearsal-ready`)} aria-label={`Mark ${part.name.toLowerCase()} rehearsal-ready`}>Mark ready</button>:null}</li>)}</ul>
      </article></div><p role="status" aria-live="polite" className="coordination-status">{message}</p>
    <details><summary>Schedule a rehearsal</summary><fieldset><legend>Candidate windows</legend><label><input type="radio" name="slot"/> Sunday, 1:30 AM (before clock change)</label><label><input type="radio" name="slot"/> Sunday, 2:00 AM (after clock change)</label></fieldset><button className="primary" onClick={()=>setMessage("Rehearsal published; connected calendars will receive one update")}>Publish rehearsal</button></details>
  </section>;
}

export function App(){const [eventId,setEventId]=useState<(typeof EVENTS)[number]["id"]>(EVENTS[0].id);const selectedEvent=EVENTS.find(({id})=>id===eventId)??EVENTS[0];return <div className="app-shell"><header><a className="brand" href="/">Woodshed <small>River City Music Circle</small></a><nav aria-label="Community"><a href="#events" aria-current="page">Events</a><a href="#library">Shared library</a></nav></header><main>
  <aside id="events" aria-labelledby="events-heading"><span className="eyebrow">Community workspace</span><h1 id="events-heading">Events</h1><label htmlFor="event-switcher">Current event</label><select id="event-switcher" value={eventId} onChange={e=>setEventId(e.target.value as (typeof EVENTS)[number]["id"])}>{EVENTS.map(event=><option key={event.id} value={event.id}>{event.name}</option>)}</select><div className="event-list">{EVENTS.map(event=><button key={event.id} className={eventId===event.id?"event-card selected":"event-card"} onClick={()=>setEventId(event.id)}><strong>{event.name}</strong><span>{event.status} · {event.visibility}</span></button>)}</div></aside>
  <div className="content"><section className="focus-card" aria-labelledby="selected-event"><div><span className="eyebrow">Selected event</span><h1 id="selected-event">{selectedEvent.name}</h1><p>This event’s choices and attributes are grouped here, distinct from neighboring events.</p></div><dl><div><dt>Status</dt><dd>{selectedEvent.status}</dd></div><div><dt>Visibility</dt><dd>{selectedEvent.visibility}</dd></div><div><dt>Entry</dt><dd>{selectedEvent.entry}</dd></div></dl></section><div className="assurance" role="status"><strong>Invite-confirmed participation</strong><span>Your event link was exchanged for a private session. This browser no longer needs the link.</span></div><RankedBallot/><section className="panel"><span className="eyebrow">Not on the list?</span><h2>Propose a song</h2><form><label htmlFor="proposal">Song title</label><div className="inline"><input id="proposal" required placeholder="Enter a song title"/><button className="secondary">Send for consideration</button></div><p className="hint">This organizer reviews proposals before they enter voting.</p></form></section><RehearsalWorkspace/></div>
  </main></div>}
