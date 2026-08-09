export const STANDARD_PARTS=["lead-vocal","harmony-vocal","drums","bass","lead-guitar","soloist"] as const;
export type Readiness="interested"|"learning"|"rehearsal-ready"|"performance-ready";
export type AssignmentState="volunteered"|"offered"|"accepted"|"assigned"|"declined"|"withdrawn"|"substituted";
export type ArrangementPart={id:string;name:string;required:boolean};
export type ArrangementVersion={id:string;communityId:string;eventId:string;songId:string;revision:number;key:string;notes:string;rightsState:"cleared"|"restricted"|"unknown";parts:readonly ArrangementPart[];createdAt:string};
export type PerformanceAssignment={id:string;communityId:string;eventId:string;decisionId:string;decisionRevision:number;partId:string;performerId:string;level:"interested"|"backup"|"committed";backup:boolean;state:AssignmentState;readiness:Readiness;revision:number};
