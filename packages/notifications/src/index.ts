export type DeliveryState="pending"|"sent"|"revoked";
export type DeliveryRecord={id:string;connectionId:string;requestHash:string;state:DeliveryState;attempts:number};
