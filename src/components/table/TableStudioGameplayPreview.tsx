import React from 'react';
import { TABLE_BACKGROUNDS, TABLE_SKINS } from '../../assets/tableAssets';
import { normalizeBackgroundId, normalizeFeltId } from '../../lib/tableTheme';
import { CardBack, normalizeCardBack } from './CardImage';
import './TableStudioGameplayPreview.css';

export interface TableStudioPreviewSelection {
  table_id: string;
  background_id: string;
  button_id: string;
  cards_id: string;
}

interface Props {
  selection: TableStudioPreviewSelection;
  avatarUrls: readonly string[];
  finalTable: boolean;
}

const SEATS = [
  { name: 'Maya', stack: '188K' },
  { name: 'Daniel', stack: '420K' },
  { name: 'Ari', stack: '597K' },
  { name: 'Nico', stack: '155K' },
  { name: 'Jordan', stack: '388K' },
  { name: 'Tiffany', stack: '176K' },
];

export function TableStudioGameplayPreview({ selection, avatarUrls, finalTable }: Props) {
  const background = finalTable
    ? TABLE_BACKGROUNDS.final_table_broadcast
    : TABLE_BACKGROUNDS[normalizeBackgroundId(selection.background_id)] ||
      TABLE_BACKGROUNDS.midnight;
  const table = finalTable
    ? TABLE_SKINS.final_table
    : TABLE_SKINS[normalizeFeltId(selection.table_id)] || TABLE_SKINS.classic_green;

  return (
    <div
      className={`studio-game-preview${finalTable ? ' studio-game-preview--final' : ''}`}
      data-button-theme={selection.button_id}
      data-table-theme={finalTable ? 'final_table' : normalizeFeltId(selection.table_id)}
      data-background-theme={
        finalTable ? 'final_table_broadcast' : normalizeBackgroundId(selection.background_id)
      }
      data-card-back={normalizeCardBack(selection.cards_id)}
      aria-label={
        finalTable
          ? 'Final Table Gameplay Preview Using Avatars From Your Avatar Library'
          : 'Gameplay Preview Using Avatars From Your Avatar Library'
      }
    >
      <img
        className="studio-game-preview__background-ambient"
        src={background}
        alt=""
        loading="eager"
        decoding="async"
      />
      <img
        className="studio-game-preview__background"
        src={background}
        alt=""
        loading="eager"
        decoding="async"
        fetchPriority="high"
      />
      <div className="studio-game-preview__scrim" />
      <img
        className="studio-game-preview__table"
        src={table}
        alt=""
        loading="eager"
        decoding="async"
        fetchPriority="high"
      />

      {SEATS.map((seat, index) => (
        <div
          className={`studio-game-preview__seat studio-game-preview__seat--${index + 1}`}
          key={seat.name}
        >
          {avatarUrls[index] ? (
            <img src={avatarUrls[index]} alt="" loading="lazy" decoding="async" />
          ) : (
            <span className="studio-game-preview__avatar-loading" aria-hidden="true" />
          )}
          <span className="studio-game-preview__plate">
            <strong>{seat.name}</strong>
            <b>{seat.stack}</b>
          </span>
        </div>
      ))}

      <div className="studio-game-preview__pot">POT 24,800</div>
      <div className="studio-game-preview__board" aria-hidden="true">
        <span className="red">A♥</span>
        <span>10♣</span>
        <span className="red">7♦</span>
        <span>6♠</span>
        <span>4♣</span>
      </div>
      <div className="studio-game-preview__hole-cards">
        <CardBack style={normalizeCardBack(selection.cards_id)} size="sm" />
        <CardBack style={normalizeCardBack(selection.cards_id)} size="sm" />
      </div>
      <div className="studio-game-preview__dealer" data-button-theme={selection.button_id}>
        D
      </div>
      <div className="studio-game-preview__actions" aria-hidden="true">
        <span>FOLD</span>
        <span>CHECK</span>
        <span>RAISE</span>
      </div>
      {finalTable && (
        <div className="studio-game-preview__broadcast">
          <span>CHAMPIONSHIP TABLE</span>
          <strong>FINAL 6</strong>
        </div>
      )}
    </div>
  );
}

export default TableStudioGameplayPreview;
