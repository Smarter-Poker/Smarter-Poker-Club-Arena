import React, { useState, useEffect } from 'react';
import { AgentService } from '../../services';
import './AgentHierarchyTree.css';
import { reportError } from '../../utils/errorReporter';

interface AgentNode {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  tier: 'super' | 'master' | 'sub';
  playerCount: number;
  totalVolume: number;
  commissionRate: number;
  children: AgentNode[];
}

interface AgentHierarchyTreeProps {
  rootAgentId?: string;
  onSelectAgent?: (agent: AgentNode) => void;
}

export const AgentHierarchyTree: React.FC<AgentHierarchyTreeProps> = ({
  rootAgentId,
  onSelectAgent,
}) => {
  const [hierarchy, setHierarchy] = useState<AgentNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [visibleNodes, setVisibleNodes] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!loading && hierarchy) {
      const collectNodeIds = (node: AgentNode, ids: Set<string>, depth: number = 0) => {
        setTimeout(
          () => ids.add(node.id) && setVisibleNodes((prev) => new Set(prev).add(node.id)),
          depth * 60
        );
        node.children?.forEach((child) => collectNodeIds(child, ids, depth + 1));
      };
      const ids = new Set<string>();
      collectNodeIds(hierarchy, ids);
    }
  }, [loading, hierarchy]);

  useEffect(() => {
    loadHierarchy();
  }, [rootAgentId]);

  const loadHierarchy = async () => {
    setLoading(true);
    try {
      const data = await AgentService.getAgentHierarchy(rootAgentId || '');
      const rootNode = data?.[0] || null;
      setHierarchy(rootNode);
      // Auto-expand first level
      if (rootNode) {
        setExpandedNodes(new Set([rootNode.id]));
      }
    } catch (error) {
      reportError(error, 'AgentHierarchyTree.Failed_to_load_hierarchy');
    } finally {
      setLoading(false);
    }
  };

  const toggleExpand = (nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  };

  const renderNode = (node: AgentNode, depth: number = 0) => {
    const isExpanded = expandedNodes.has(node.id);
    const hasChildren = node.children && node.children.length > 0;

    return (
      <div
        key={node.id}
        className="hierarchy-node"
        style={
          {
            '--depth': depth,
            opacity: visibleNodes.has(node.id) ? 1 : 0,
            transform: visibleNodes.has(node.id) ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          } as React.CSSProperties
        }
      >
        <div className={`node-content tier-${node.tier}`} onClick={() => onSelectAgent?.(node)}>
          {hasChildren && (
            <button
              className={`expand-btn ${isExpanded ? 'expanded' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                toggleExpand(node.id);
              }}
            >
              ▶
            </button>
          )}
          {!hasChildren && <span className="expand-placeholder" />}

          <div className="node-avatar">
            {node.avatarUrl ? (
              <img loading="lazy" decoding="async" src={node.avatarUrl} alt={node.displayName} />
            ) : (
              <span>{(node.displayName || '?')[0]}</span>
            )}
          </div>

          <div className="node-info">
            <div className="node-name">{node.displayName}</div>
            <div className="node-meta">
              <span className="tier-badge">{node.tier}</span>
              <span className="player-count"> {node.playerCount}</span>
              <span className="commission">{(node.commissionRate * 100).toFixed(1)}%</span>
            </div>
          </div>

          <div className="node-volume">
            <div className="volume-label">Volume</div>
            <div className="volume-value">{node.totalVolume.toLocaleString()}</div>
          </div>
        </div>

        {hasChildren && isExpanded && (
          <div className="node-children">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  if (loading) {
    return <div className="hierarchy-loading">Loading Hierarchy...</div>;
  }

  if (!hierarchy) {
    return <div className="hierarchy-empty">No Agent Hierarchy Found</div>;
  }

  return (
    <div className="agent-hierarchy-tree">
      <div className="hierarchy-header">
        <h3>Agent Hierarchy</h3>
        <button className="refresh-btn" onClick={loadHierarchy}>
          ↻ Refresh
        </button>
      </div>
      <div className="hierarchy-container">{renderNode(hierarchy)}</div>
    </div>
  );
};

export default AgentHierarchyTree;
