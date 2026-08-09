export const QUEUE_ENTRY_STATES=["suggested","planned","queued","current","performed","skipped","deferred","restored"] as const;
export type QueueEntryState=typeof QUEUE_ENTRY_STATES[number];

const transitions:Record<QueueEntryState,readonly QueueEntryState[]>={
  suggested:["planned","queued","deferred"], planned:["queued","skipped","deferred"], queued:["current","skipped","deferred"],
  current:["performed","skipped","deferred"], performed:[], skipped:["restored"], deferred:["restored"], restored:["queued","current","skipped","deferred"],
};
export function transitionQueueEntry(from:QueueEntryState,to:QueueEntryState){if(!transitions[from].includes(to))throw new Error(`invalid-transition:${from}->${to}`);return to;}
export type QueueEntry={id:string;communityId:string;eventId:string;songId:string;state:QueueEntryState;revision:number;audienceVisible:boolean;createdAt:string;updatedAt:string};
export type PerformanceRecord={id:string;eventId:string;entryId:string;songId:string;performedAt:string;authorityEpoch:number;revision:number};

export function suggestedNext(entries:readonly QueueEntry[]){return entries.filter(entry=>entry.state==="queued"||entry.state==="restored").sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))[0]??null;}
