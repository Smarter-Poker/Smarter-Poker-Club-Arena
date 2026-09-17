"""Strict JSON and explicit return shapes for the five local catalog call sites."""
import json


def decode_catalog_result(stdout, shape, canonical_oid, case_names):
    # Never recognize psql t/f, truthy strings, row-count text or an empty result
    # as a JSON boolean. SQL is responsible for explicit JSON serialization.
    value = json.loads(stdout)
    if shape == 'template_size':
        if type(value) is not int or value <= 0:
            raise ValueError('Template database bytes must be a positive JSON integer')
    elif shape == 'case_names':
        if (type(value) is not list or any(type(v) is not str or v not in case_names for v in value)
                or len(value) != len(set(value))):
            raise ValueError('Remaining databases must be a unique JSON array of exact case names')
    elif shape == 'created_oid':
        canonical_oid(value)
    elif shape == 'existing_database':
        if type(value) is not dict or set(value) != {'oid', 'sessions'}:
            raise ValueError('Existing database observation must contain exactly oid and sessions')
        if value['oid'] is not None:
            canonical_oid(value['oid'])
        if type(value['sessions']) is not int or value['sessions'] < 0:
            raise ValueError('Session count must be a nonnegative JSON integer')
    elif shape == 'absence':
        if type(value) is not bool:
            raise ValueError('Absence evidence must be a JSON boolean')
        # False remains False. The caller still requires `absent is True`.
    else:
        raise ValueError('Unrecognized catalog result shape')
    return value
