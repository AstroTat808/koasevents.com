"""Read-only-testable guards for SHA-pinned branch retirement.

The issue ledger is the durable authority. Absence of a ref alone never proves
that this workflow deleted it; an unfinished intent remains unresolved.
"""
from __future__ import annotations

import json
import re
import uuid
from typing import Callable

MARKER = '<!-- koa-retirement-event-v1 -->\n'
SHA = re.compile(r'^[0-9a-f]{40}$')
OUTCOMES = {'DELETED', 'SKIPPED', 'REJECTED', 'REFUSED', 'UNKNOWN'}


class RetirementStopped(RuntimeError):
    """No more remote mutations are permitted during this invocation."""


def paginated_list(fetch: Callable, path: str, *, max_pages: int = 1000) -> list:
    """Require every list page and unique numeric IDs; never truncate a scan."""
    if any(key in path for key in ('per_page=', 'page=')):
        raise ValueError('Pagination must be owned by the complete-list helper')
    result, ids = [], set()
    separator = '&' if '?' in path else '?'
    for page in range(1, max_pages + 1):
        rows = fetch(f'{path}{separator}per_page=100&page={page}')
        if not isinstance(rows, list) or len(rows) > 100:
            raise RetirementStopped('Incomplete or malformed paginated GitHub evidence')
        for row in rows:
            identifier = row.get('id') if isinstance(row, dict) else None
            if type(identifier) is not int or identifier <= 0 or identifier in ids:
                raise RetirementStopped('Repeated or invalid paginated GitHub evidence')
            ids.add(identifier)
            result.append(row)
        if len(rows) < 100:
            return result
    raise RetirementStopped('GitHub evidence exceeded the complete pagination bound')


def has_active_dependency(rows: list, branch: str) -> bool:
    for row in rows:
        if not isinstance(row, dict):
            raise RetirementStopped('Malformed active pull request evidence')
        for side in ('head', 'base'):
            ref = (row.get(side) or {}).get('ref')
            if not isinstance(ref, str) or not ref:
                raise RetirementStopped('Missing active pull request dependency metadata')
            if ref == branch:
                return True
    return False


class RetirementLedger:
    def __init__(self, approved: list, digest: str, comments: list, persist: Callable):
        self.approved = {row['branch']: row['sha'] for row in approved}
        if len(self.approved) != len(approved) or any(not SHA.fullmatch(tip) for tip in self.approved.values()):
            raise RetirementStopped('Invalid immutable retirement whitelist')
        self.digest, self.persist = digest, persist
        self.intents, self.outcomes = {}, {}
        for comment in sorted(comments, key=lambda item: item['id']):
            body = str(comment.get('body') or '')
            if not body.startswith(MARKER):
                if 'Pre-deletion intent' in body or '**DELETED**' in body:
                    raise RetirementStopped('Legacy deletion evidence requires explicit reconciliation')
                continue
            try:
                entry = json.loads(body[len(MARKER):])
            except (ValueError, TypeError):
                raise RetirementStopped('Malformed durable retirement event') from None
            self._accept(entry)

    def _validate(self, entry: dict) -> None:
        if not isinstance(entry, dict):
            raise RetirementStopped('Invalid durable retirement event')
        branch, expected = entry.get('branch'), entry.get('expected_sha')
        if (entry.get('schema_version') != 1 or entry.get('snapshot_sha256') != self.digest
                or not isinstance(branch, str) or self.approved.get(branch) != expected
                or not SHA.fullmatch(str(entry.get('release_sha') or ''))
                or not re.fullmatch(r'[0-9a-f]{32}', str(entry.get('operation_id') or ''))
                or entry.get('phase') not in {'intent', 'outcome'}):
            raise RetirementStopped('Durable event does not match the immutable authorization')
        if entry['phase'] == 'outcome':
            result = entry.get('result')
            if (not isinstance(result, dict) or result.get('branch') != branch
                    or result.get('expected_sha') != expected
                    or result.get('outcome') not in OUTCOMES
                    or not isinstance(result.get('detail'), str)):
                raise RetirementStopped('Malformed durable retirement outcome')

    def _accept(self, entry: dict) -> None:
        self._validate(entry)
        branch = entry['branch']
        if entry['phase'] == 'intent':
            if branch in self.intents:
                raise RetirementStopped('Duplicate retirement intent; do not retry automatically')
            self.intents[branch] = entry
            return
        intent = self.intents.get(branch)
        if (not intent or intent['operation_id'] != entry['operation_id']
                or intent['release_sha'] != entry['release_sha'] or branch in self.outcomes):
            raise RetirementStopped('Outcome has no unique matching durable intent')
        self.outcomes[branch] = entry['result']

    def preflight(self, remote_tip: Callable) -> None:
        """Stop globally before resuming if any prior mutation is uncertain."""
        for branch, intent in self.intents.items():
            result = self.outcomes.get(branch)
            if result is None or result['outcome'] == 'UNKNOWN':
                raise RetirementStopped('Unresolved durable deletion intent; no deletion can be inferred')
            tip = remote_tip(branch)
            if result['outcome'] == 'DELETED' and tip:
                raise RetirementStopped('A previously deleted branch exists again; preserve it')
            if result['outcome'] != 'DELETED' and not tip and result.get('present_before') is not False:
                raise RetirementStopped('A previously preserved branch is unexpectedly absent')

    def _persist(self, entry: dict) -> None:
        self._validate(entry)
        body = MARKER + json.dumps(entry, sort_keys=True, separators=(',', ':'))
        # The callback must POST and read back the exact comment before returning.
        if self.persist(body) is not True:
            raise RetirementStopped('Durable retirement event was not confirmed')
        self._accept(entry)

    def perform(self, row: dict, release_sha: str, operation: Callable, checkpoint: Callable) -> dict:
        branch, expected = row['branch'], row['sha']
        if self.approved.get(branch) != expected:
            raise RetirementStopped('Attempted operation is outside the immutable whitelist')
        if branch in self.outcomes:
            result = dict(self.outcomes[branch])
            if result['outcome'] == 'UNKNOWN':
                raise RetirementStopped('Unknown prior deletion outcome remains unresolved')
            result['resumed_from_ledger'] = True
            checkpoint(result)
            return result
        if branch in self.intents:
            raise RetirementStopped('Unfinished prior intent cannot be retried automatically')
        event = {
            'schema_version': 1, 'snapshot_sha256': self.digest,
            'branch': branch, 'expected_sha': expected, 'release_sha': release_sha,
            'operation_id': uuid.uuid4().hex, 'phase': 'intent',
        }
        self._persist(event)
        try:
            result = operation()
        except BaseException:
            # A killed process cannot be made atomic with a remote Git push.
            # Record uncertainty when possible; never invent success on resume.
            result = {'branch': branch, 'expected_sha': expected, 'outcome': 'UNKNOWN',
                      'detail': 'Operation interrupted; exact remote acceptance requires reconciliation'}
            checkpoint(result)
            self._persist({**event, 'phase': 'outcome', 'result': result})
            raise
        outcome_event = {**event, 'phase': 'outcome', 'result': result}
        self._validate(outcome_event)
        checkpoint(result)
        self._persist(outcome_event)
        if result['outcome'] in {'UNKNOWN', 'REFUSED'}:
            raise RetirementStopped('Retirement stopped after an uncertain or refused operation')
        return result


def self_test() -> None:
    """All scenarios are synthetic in-memory tests; no GitHub or Git mutation."""
    import unittest

    class SafetyTests(unittest.TestCase):
        def setUp(self):
            self.rows = [{'branch': 'feature/one', 'sha': 'a' * 40},
                         {'branch': 'feature/two', 'sha': 'b' * 40}]
            self.digest = 'd' * 64
            self.comments, self.checkpoints, self.calls = [], [], []
            self.remote = {row['branch']: row['sha'] for row in self.rows}

        def persist(self, body):
            self.comments.append({'id': len(self.comments) + 1, 'body': body})
            return True

        def ledger(self, persist=None):
            return RetirementLedger(self.rows, self.digest, self.comments, persist or self.persist)

        def delete(self, row):
            self.calls.append(row['branch'])
            self.remote.pop(row['branch'])
            return {**{'branch': row['branch'], 'expected_sha': row['sha']},
                    'outcome': 'DELETED', 'detail': 'Exact lease accepted', 'present_before': True}

        def test_page_two_protects_head_and_base(self):
            first = [{'id': n, 'head': {'ref': f'other/{n}'}, 'base': {'ref': 'main'}} for n in range(1, 101)]
            for side in ('head', 'base'):
                last = {'id': 101, 'head': {'ref': 'other/last'}, 'base': {'ref': 'main'}}
                last[side]['ref'] = 'feature/one'
                pages = lambda path: first if path.endswith('page=1') else [last]
                self.assertTrue(has_active_dependency(paginated_list(pages, '/pulls?state=open'), 'feature/one'))

        def test_failed_page_two_fails_closed(self):
            def fetch(path):
                if path.endswith('page=2'):
                    raise RuntimeError('unavailable')
                return [{'id': n} for n in range(1, 101)]
            with self.assertRaises(RuntimeError):
                paginated_list(fetch, '/pulls')

        def test_duplicate_and_truncated_pages_rejected(self):
            pages = lambda path: [{'id': n} for n in range(1, 101)]
            with self.assertRaises(RetirementStopped):
                paginated_list(pages, '/pulls')
            with self.assertRaises(RetirementStopped):
                paginated_list(pages, '/pulls', max_pages=1)
            with self.assertRaises(RetirementStopped):
                paginated_list(lambda path: {}, '/pulls')
            with self.assertRaises(RetirementStopped):
                has_active_dependency([{'id': 1}], 'feature/one')

        def test_durable_success_can_resume_without_redelete(self):
            ledger = self.ledger()
            ledger.perform(self.rows[0], 'c' * 40, lambda: self.delete(self.rows[0]), self.checkpoints.append)
            restarted = self.ledger()
            restarted.preflight(self.remote.get)
            result = restarted.perform(self.rows[0], 'c' * 40, lambda: self.fail('repeated delete'), self.checkpoints.append)
            self.assertEqual(result['outcome'], 'DELETED')
            self.assertTrue(result['resumed_from_ledger'])
            self.assertEqual(len(self.calls), 1)

        def test_failed_intent_means_no_delete(self):
            with self.assertRaises(RetirementStopped):
                self.ledger(lambda body: False).perform(self.rows[0], 'c' * 40,
                    lambda: self.delete(self.rows[0]), self.checkpoints.append)
            self.assertEqual(self.calls, [])

        def test_failed_outcome_persistence_stops_before_second_ref(self):
            def persist(body):
                if '"phase":"outcome"' in body:
                    raise RuntimeError('issue write unavailable')
                return self.persist(body)
            ledger = self.ledger(persist)
            with self.assertRaises(RuntimeError):
                for row in self.rows:
                    ledger.perform(row, 'c' * 40, lambda row=row: self.delete(row), self.checkpoints.append)
            self.assertEqual(self.calls, ['feature/one'])
            with self.assertRaises(RetirementStopped):
                self.ledger().preflight(self.remote.get)

        def test_interruption_after_remote_acceptance_is_unknown(self):
            def operation():
                self.delete(self.rows[0])
                raise KeyboardInterrupt()
            with self.assertRaises(KeyboardInterrupt):
                self.ledger().perform(self.rows[0], 'c' * 40, operation, self.checkpoints.append)
            self.assertEqual(self.checkpoints[-1]['outcome'], 'UNKNOWN')
            with self.assertRaises(RetirementStopped):
                self.ledger().preflight(self.remote.get)

        def test_moved_main_is_refused_without_deleting(self):
            def operation():
                return {'branch': self.rows[0]['branch'], 'expected_sha': self.rows[0]['sha'],
                        'outcome': 'REFUSED', 'detail': 'Main changed', 'present_before': True}
            with self.assertRaises(RetirementStopped):
                self.ledger().perform(self.rows[0], 'c' * 40, operation, self.checkpoints.append)
            self.assertEqual(self.calls, [])
            self.assertEqual(self.checkpoints[-1]['outcome'], 'REFUSED')

        def test_recreated_branch_and_forged_tip_are_preserved(self):
            self.ledger().perform(self.rows[0], 'c' * 40, lambda: self.delete(self.rows[0]), self.checkpoints.append)
            self.remote['feature/one'] = 'f' * 40
            with self.assertRaises(RetirementStopped):
                self.ledger().preflight(self.remote.get)
            with self.assertRaises(RetirementStopped):
                self.ledger().perform({'branch': 'feature/one', 'sha': 'f' * 40}, 'c' * 40,
                                     lambda: self.fail('forged delete'), self.checkpoints.append)

        def test_outcome_readback_loss_can_resume_when_comment_exists(self):
            def persist(body):
                self.persist(body)
                if '"phase":"outcome"' in body:
                    raise RuntimeError('readback connection lost')
                return True
            with self.assertRaises(RuntimeError):
                self.ledger(persist).perform(self.rows[0], 'c' * 40,
                    lambda: self.delete(self.rows[0]), self.checkpoints.append)
            restarted = self.ledger()
            restarted.preflight(self.remote.get)
            self.assertEqual(restarted.outcomes['feature/one']['outcome'], 'DELETED')

    result = unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromTestCase(SafetyTests))
    if not result.wasSuccessful():
        raise RuntimeError('Retirement ledger regression tests failed')


if __name__ == '__main__':
    self_test()
