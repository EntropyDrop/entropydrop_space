import pytest

from space.hosting_worker import HostedEntityInbox


def test_click_and_message_floods_cannot_evict_each_other():
    inbox = HostedEntityInbox()
    inbox.append({'messageId': 'ordinary'})
    for index in range(70):
        inbox.append({'clickedBlock': {'eventId': str(index), 'playerId': 'visitor'}})
    assert list(inbox.messages) == [{'messageId': 'ordinary'}]
    assert len(inbox.clicks) == 64
    assert inbox.clicks[0]['clickedBlock']['eventId'] == '6'
    for index in range(70):
        inbox.append({'messageId': str(index)})
    assert len(inbox.messages) == 64
    assert len(inbox.clicks) == 64
    assert inbox.messages[0]['messageId'] == '6'
    assert len(inbox.batch()) == 128


def test_only_committed_indices_are_removed_from_the_original_batch():
    inbox = HostedEntityInbox()
    inbox.append({'messageId': 'ordinary'})
    inbox.append({'clickedBlock': {'eventId': 'bad', 'playerId': 'visitor'}})
    inbox.append({'clickedBlock': {'eventId': 'first', 'playerId': 'visitor'}})
    inbox.append({'clickedBlock': {'eventId': 'second', 'playerId': 'visitor'}})
    batch = inbox.batch()
    consumed = inbox.validate_acknowledgement(batch, [0, 1, 3])
    assert inbox.batch() == batch, 'validation must leave all inputs available if the commit fails'
    inbox.acknowledge(consumed)
    assert inbox.batch() == [batch[2]], 'an unconsumed click survives a non-prefix acknowledgement'
    inbox.clear()
    assert inbox.batch() == []


def test_click_deduplication_survives_hosted_batches_and_is_scoped_to_players():
    inbox = HostedEntityInbox()
    first = {'clickedBlock': {'eventId': 'same', 'playerId': 'visitor-1'}}
    second = {'clickedBlock': {'eventId': 'same', 'playerId': 'visitor-2'}}
    inbox.append(first)
    inbox.append(second)
    assert inbox.batch() == [first, second]
    inbox.acknowledge(inbox.validate_acknowledgement(inbox.batch(), [0, 1]))
    inbox.append(first)
    inbox.append(second)
    assert inbox.batch() == [], 'duplicates cannot re-execute in a later transaction batch'
    inbox.clear()
    inbox.append(first)
    assert inbox.batch() == [first], 'a new execution clears duplicate suppression'


@pytest.mark.parametrize('indices', [None, 1, [True], [-1], [1], [0, 0], ['0'], [[]]])
def test_invalid_acknowledgements_are_rejected_without_consuming_input(indices):
    inbox = HostedEntityInbox()
    inbox.append({'messageId': 'ordinary'})
    batch = inbox.batch()
    with pytest.raises(ValueError, match='invalid consumed message indices'):
        inbox.validate_acknowledgement(batch, indices)
    assert inbox.batch() == batch
