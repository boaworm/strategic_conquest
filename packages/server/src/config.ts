const argv = process.argv.slice(2);
export const VERBOSE =
  process.env.VERBOSE === '1' || argv.includes('--verbose');
