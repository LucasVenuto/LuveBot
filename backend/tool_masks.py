"""A registry of masks for what a tool returned (A-284 (1)): the proxy asks it about every frame of a stream, every row of a history page and every row of a search, and it asks whoever registered.

Neutral and public: it knows no tool, no folder and no word of what a mask hides. A mask is any object with these methods, each optional:
  new_state()                          -> what the mask keeps for ONE stream or ONE page (the call ids it has seen)
  scan(rows, state)                    -> the pass over a history page before any row is answered (the call that comes AFTER its result in the page counts too)
  frame(state, event, data)            -> the data to send for one frame
  row(state, row, viewer)              -> the row to send for one history row (`viewer` is the identity that asked)
  drops(row)                           -> True when a search must not see this row at all
FAIL CLOSED: a mask that raises (or a state that could not be made) turns the frame or the row into the neutral line `HIDDEN`, and a search row is dropped; with nothing registered everything passes through untouched. The registry is filled when the plugin loads, and a registration that fails stops that load."""
HIDDEN = 'result hidden'
KEEP = ('event', 'tool', 'tool_name', 'tool_call_id', 'seq', 'run_id', 'session_id', 'id', 'role', 'timestamp')      # what survives in a neutral frame or row: identifiers, never text
_MASKS = []
_BROKEN = object()


def register(mask):
    _MASKS.append(mask)


def _states():
    out = []
    for mask in list(_MASKS):
        try:
            out.append((mask, mask.new_state() if hasattr(mask, 'new_state') else None))
        except Exception:  # noqa: BLE001
            out.append((mask, _BROKEN))
    return out


def stream():
    """The state of ONE stream: made when it opens, handed to every `mask_frame` of it (a mask registered later does not mask a stream that was already open)."""
    return _states()


def scan(rows):
    """The state of ONE history page, after every mask has looked at the whole page."""
    states = _states()
    for index, (mask, state) in enumerate(states):
        if state is _BROKEN or not hasattr(mask, 'scan'):
            continue
        try:
            mask.scan(rows, state)
        except Exception:  # noqa: BLE001
            states[index] = (mask, _BROKEN)
    return states


def neutral_frame(data):
    out = {key: data[key] for key in KEEP if isinstance(data, dict) and key in data and isinstance(data[key], (str, int, float)) and not isinstance(data[key], bool)}
    out.update(preview=HIDDEN, masked={'kind': 'hidden'})
    return out


def neutral_row(row):
    out = {key: row[key] for key in KEEP if isinstance(row, dict) and key in row and isinstance(row[key], (str, int, float)) and not isinstance(row[key], bool)}
    out.update(content=HIDDEN, display_content=HIDDEN, masked={'kind': 'hidden'})
    return out


def mask_frame(states, event, data):
    for mask, state in states:
        if not hasattr(mask, 'frame'):
            continue
        try:
            if state is _BROKEN:
                raise RuntimeError('state')
            data = mask.frame(state, event, data)
        except Exception:  # noqa: BLE001
            return neutral_frame(data)
    return data


def mask_row(states, row, viewer=None):
    for mask, state in states:
        if not hasattr(mask, 'row'):
            continue
        try:
            if state is _BROKEN:
                raise RuntimeError('state')
            row = mask.row(state, row, viewer)
        except Exception:  # noqa: BLE001
            return neutral_row(row)
    return row


def drops_rows():
    """Whether a registered mask refuses search rows at all (the search then asks for more results than it shows: what a mask drops must not count against the limit)."""
    return any(hasattr(mask, 'drops') for mask in list(_MASKS))


def drop_row(row):
    for mask in list(_MASKS):
        if not hasattr(mask, 'drops'):
            continue
        try:
            if mask.drops(row):
                return True
        except Exception:  # noqa: BLE001
            return True
    return False
