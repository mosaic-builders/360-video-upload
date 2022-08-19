
SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]:-$0}"; )" &> /dev/null && pwd 2> /dev/null; )";

ORIG_PWD=$PWD
cd $SCRIPT_DIR/..

ts-node src/parse.ts $ORIG_PWD $@

cd $ORIG_PWD