// Headlines the PR team flagged as noise on previous runs. The classifier
// splices these into its prompt so these — and near-duplicates — get marked
// is_relevant:false. Starts empty; grow it from the board's thumbs-down.
export const NEGATIVES = [];
