export type Availability="available"|"if-needed"|"unavailable";
export type RehearsalSlot={id:string;startsAt:string;endsAt:string};

export function validateTimeZone(value:string){try{new Intl.DateTimeFormat("en",{timeZone:value}).format();return value;}catch{throw new Error("invalid-time-zone");}}
export function validateSlot(slot:RehearsalSlot){const start=Date.parse(slot.startsAt),end=Date.parse(slot.endsAt);if(!slot.id||!Number.isFinite(start)||!Number.isFinite(end)||end<=start)throw new Error("invalid-slot");return slot;}
export function rankAvailability(slots:readonly RehearsalSlot[],responses:ReadonlyMap<string,Readonly<Record<string,Availability>>>,required:ReadonlySet<string>){
  return slots.map(slot=>{let score=0,requiredUnavailable=0;for(const [person,answer] of responses){const weight=required.has(person)?4:1;const value=answer[slot.id];if(value==="available")score+=2*weight;else if(value==="if-needed")score+=weight;else if(value==="unavailable"&&required.has(person))requiredUnavailable++;}return {slotId:slot.id,score,requiredUnavailable,startsAt:slot.startsAt};}).sort((a,b)=>a.requiredUnavailable-b.requiredUnavailable||b.score-a.score||a.startsAt.localeCompare(b.startsAt)||a.slotId.localeCompare(b.slotId));
}
