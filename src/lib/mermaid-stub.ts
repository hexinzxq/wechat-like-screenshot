const mermaid = {
  initialize() {
    return undefined;
  },
  parse() {
    return Promise.resolve(true);
  },
  render() {
    return Promise.reject(new Error("Mermaid conversion is disabled in this build."));
  }
};

export default mermaid;
