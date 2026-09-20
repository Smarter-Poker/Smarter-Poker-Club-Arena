"""Pure strict normalization of the two observed PostgreSQL OID JSON shapes."""


def canonical_oid(value):
    # PostgreSQL OIDs are unsigned 32-bit identifiers. Zero is invalid here:
    # the runner must identify an actual freshly-created database.
    if type(value) is int:
        number = value
    elif type(value) is str and value.isascii() and value.isdigit():
        number = int(value)
        if value != str(number):
            raise ValueError('Database OID text is not canonical decimal')
    else:
        raise ValueError('Database OID must be an integer or canonical decimal string')
    if not 0 < number <= 4294967295:
        raise ValueError('Database OID is outside the valid positive uint32 range')
    return str(number)


def require_owned_database_identity(expected, actual, sessions):
    actual_oid = canonical_oid(actual)
    if type(sessions) is not int or sessions != 0:
        raise RuntimeError('Owned case database still has sessions or invalid session metadata')
    # An ambiguous failed CREATE may have no acknowledged original OID. The
    # caller still requires this fresh private cluster, the exact allowlisted
    # name and its pre-CREATE absence; this preserves the preceding protocol.
    if expected is not None and canonical_oid(expected) != actual_oid:
        raise RuntimeError('Owned case database OID changed')
    return actual_oid
