/** A valid entry was superseded by inventory or an in-flight buy in this asset price zone. */
export class DuplicateAssetExposureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateAssetExposureError";
  }
}
