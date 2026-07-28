//#region src/helpers.d.ts
declare const handleResponse: (response: Response) => Promise<any>;
declare const innerModule: (body: BodyInit, headers: HeadersInit, preffix: string, name: string) => {
  data: Promise<any>;
  cancel: (reason: string) => void;
};
//#endregion
export { handleResponse, innerModule };
//# sourceMappingURL=helpers.d.mts.map