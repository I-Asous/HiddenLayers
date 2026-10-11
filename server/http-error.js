// An error with the HTTP status to answer with. Its message is shown to the player.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
