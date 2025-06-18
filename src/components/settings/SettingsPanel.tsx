import { useEffect, useState } from "react";
import { Button } from "@/components/button/Button";
import { Card } from "@/components/card/Card";
import { TextArea } from "@/components/input/TextArea";
import { X, Robot, Plus, Trash, Pencil } from "@phosphor-icons/react";

interface EmojiPersona {
  id: string;
  emoji: string;
  name: string;
  description: string;
  instructions: string;
  model_preference?: string;
  created: string;
  modified: string;
}

interface SettingsPanelProps {
  onClose: () => void;
  currentModel: string;
  hasAnthropicKey: boolean;
  onModelChange: (model: string) => void;
  modelSwitchLoading: boolean;
  modelSwitchError: string | null;
}

const OPENAI_MODEL_NAME = "gpt-4.1-2025-04-14";
const ANTHROPIC_MODEL_NAME = "claude-sonnet-4-20250514";

const DEFAULT_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🤖', '🧠', '✨', '🎯', '🚀', '💡', '🔥', '⚡', '🌟', '🎨', '🎭', '🧙‍♂️', '🤔', '💭', '🔍'];

export function SettingsPanel({ 
  onClose, 
  currentModel, 
  hasAnthropicKey, 
  onModelChange, 
  modelSwitchLoading, 
  modelSwitchError 
}: SettingsPanelProps) {
  const [personas, setPersonas] = useState<EmojiPersona[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingPersona, setEditingPersona] = useState<EmojiPersona | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Form state for creating/editing personas
  const [formData, setFormData] = useState({
    emoji: '',
    name: '',
    description: '',
    instructions: '',
    model_preference: ''
  });

  useEffect(() => {
    loadPersonas();
  }, []);

  const loadPersonas = async () => {
    try {
      setLoading(true);
      const response = await fetch("/agents/chat/default/emoji-personas");
      const data = await response.json();
      
      if (data.success) {
        setPersonas(data.personas);
      } else {
        setError(data.error || "Failed to load personas");
      }
    } catch (err) {
      setError("Network error loading personas");
    } finally {
      setLoading(false);
    }
  };

  const savePersona = async () => {
    if (!formData.emoji || !formData.name || !formData.description || !formData.instructions) {
      setError("All fields except model preference are required");
      return;
    }

    try {
      const url = "/agents/chat/default/emoji-personas";
      const method = editingPersona ? "PUT" : "POST";
      const payload = editingPersona 
        ? { ...formData, id: editingPersona.id }
        : formData;

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await response.json();
      
      if (data.success) {
        await loadPersonas();
        resetForm();
        setError(null);
      } else {
        setError(data.error || "Failed to save persona");
      }
    } catch (err) {
      setError("Network error saving persona");
    }
  };

  const deletePersona = async (id: string) => {
    if (!confirm("Are you sure you want to delete this persona?")) return;

    try {
      const response = await fetch("/agents/chat/default/emoji-personas", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      });

      const data = await response.json();
      
      if (data.success) {
        await loadPersonas();
        setError(null);
      } else {
        setError(data.error || "Failed to delete persona");
      }
    } catch (err) {
      setError("Network error deleting persona");
    }
  };

  const startEdit = (persona: EmojiPersona) => {
    setEditingPersona(persona);
    setFormData({
      emoji: persona.emoji,
      name: persona.name,
      description: persona.description,
      instructions: persona.instructions,
      model_preference: persona.model_preference || ''
    });
    setIsCreating(true);
    setError(null);
  };

  const startCreate = () => {
    setEditingPersona(null);
    resetForm();
    setIsCreating(true);
    setError(null);
  };

  const resetForm = () => {
    setFormData({
      emoji: '',
      name: '',
      description: '',
      instructions: '',
      model_preference: ''
    });
    setEditingPersona(null);
    setIsCreating(false);
  };

  const isEmojiTaken = (emoji: string) => {
    return personas.some(p => p.emoji === emoji && p.id !== editingPersona?.id);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-neutral-200 dark:border-neutral-800">
          <h2 className="text-xl font-semibold">Settings</h2>
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            onClick={onClose}
            className="rounded-full h-8 w-8"
          >
            <X size={16} />
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Model Selection */}
          <Card className="p-4">
            <h3 className="text-lg font-medium mb-4">AI Model</h3>
            <div className="flex items-center gap-4">
              <Button
                variant={currentModel === OPENAI_MODEL_NAME ? "primary" : "secondary"}
                onClick={() => onModelChange(OPENAI_MODEL_NAME)}
                disabled={modelSwitchLoading}
                className="flex items-center gap-2"
              >
                <Robot size={16} />
                GPT-4
              </Button>
              <Button
                variant={currentModel === ANTHROPIC_MODEL_NAME ? "primary" : "secondary"}
                onClick={() => onModelChange(ANTHROPIC_MODEL_NAME)}
                disabled={modelSwitchLoading || !hasAnthropicKey}
                className="flex items-center gap-2"
              >
                <Robot size={16} />
                Claude
              </Button>
            </div>
            {modelSwitchError && (
              <p className="text-red-500 text-sm mt-2">{modelSwitchError}</p>
            )}
            {!hasAnthropicKey && (
              <p className="text-yellow-600 dark:text-yellow-400 text-sm mt-2">
                Anthropic API key not configured
              </p>
            )}
          </Card>

          {/* Emoji Personas */}
          <Card className="p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium">Emoji Personas</h3>
              <Button
                variant="primary"
                size="sm"
                onClick={startCreate}
                className="flex items-center gap-2"
              >
                <Plus size={16} />
                Add Persona
              </Button>
            </div>

            {error && (
              <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-3 mb-4">
                <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>
              </div>
            )}

            {loading ? (
              <div className="text-center py-8">
                <div className="animate-spin h-6 w-6 border-2 border-current border-t-transparent rounded-full mx-auto"></div>
                <p className="text-sm text-neutral-500 mt-2">Loading personas...</p>
              </div>
            ) : (
              <>
                {/* Existing Personas */}
                <div className="space-y-3 mb-4">
                  {personas.map((persona) => (
                    <div key={persona.id} className="flex items-center justify-between p-3 bg-neutral-50 dark:bg-neutral-800 rounded-md">
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">{persona.emoji}</span>
                        <div>
                          <h4 className="font-medium">{persona.name}</h4>
                          <p className="text-sm text-neutral-600 dark:text-neutral-400">{persona.description}</p>
                          {persona.model_preference && (
                            <p className="text-xs text-neutral-500 mt-1">
                              Prefers: {persona.model_preference === OPENAI_MODEL_NAME ? "GPT-4" : "Claude"}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          shape="square"
                          onClick={() => startEdit(persona)}
                          className="h-8 w-8"
                        >
                          <Pencil size={14} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          shape="square"
                          onClick={() => deletePersona(persona.id)}
                          className="h-8 w-8 text-red-500 hover:text-red-600"
                        >
                          <Trash size={14} />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Create/Edit Form */}
                {isCreating && (
                  <div className="border-t border-neutral-200 dark:border-neutral-700 pt-4">
                    <h4 className="font-medium mb-3">
                      {editingPersona ? "Edit Persona" : "Create New Persona"}
                    </h4>
                    
                    <div className="space-y-4">
                      {/* Emoji Selection */}
                      <div>
                        <label className="block text-sm font-medium mb-2">Emoji</label>
                        <div className="flex flex-wrap gap-2 mb-2">
                          {DEFAULT_EMOJIS.map(emoji => (
                            <button
                              key={emoji}
                              type="button"
                              className={`text-2xl p-2 rounded-md transition-colors ${
                                formData.emoji === emoji 
                                  ? "bg-blue-100 dark:bg-blue-900" 
                                  : isEmojiTaken(emoji)
                                  ? "opacity-30 cursor-not-allowed"
                                  : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
                              }`}
                              onClick={() => !isEmojiTaken(emoji) && setFormData(prev => ({ ...prev, emoji }))}
                              disabled={isEmojiTaken(emoji)}
                            >
                              {emoji}
                            </button>
                          ))}
                        </div>
                        <input
                          type="text"
                          placeholder="Or enter custom emoji"
                          value={formData.emoji}
                          onChange={(e) => setFormData(prev => ({ ...prev, emoji: e.target.value }))}
                          className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-md bg-white dark:bg-neutral-800"
                        />
                      </div>

                      {/* Name */}
                      <div>
                        <label className="block text-sm font-medium mb-2">Name</label>
                        <input
                          type="text"
                          placeholder="e.g., Helpful Assistant, Code Reviewer, etc."
                          value={formData.name}
                          onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                          className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-md bg-white dark:bg-neutral-800"
                        />
                      </div>

                      {/* Description */}
                      <div>
                        <label className="block text-sm font-medium mb-2">Description</label>
                        <input
                          type="text"
                          placeholder="Brief description of this persona's role"
                          value={formData.description}
                          onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                          className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-md bg-white dark:bg-neutral-800"
                        />
                      </div>

                      {/* Instructions */}
                      <div>
                        <label className="block text-sm font-medium mb-2">Instructions</label>
                        <TextArea
                          placeholder="Detailed instructions on how this persona should behave and respond..."
                          value={formData.instructions}
                          onChange={(e) => setFormData(prev => ({ ...prev, instructions: e.target.value }))}
                          rows={4}
                          className="w-full"
                        />
                      </div>

                      {/* Model Preference */}
                      <div>
                        <label className="block text-sm font-medium mb-2">Model Preference (Optional)</label>
                        <select
                          value={formData.model_preference}
                          onChange={(e) => setFormData(prev => ({ ...prev, model_preference: e.target.value }))}
                          className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-md bg-white dark:bg-neutral-800"
                        >
                          <option value="">Use current model</option>
                          <option value={OPENAI_MODEL_NAME}>GPT-4</option>
                          <option value={ANTHROPIC_MODEL_NAME}>Claude</option>
                        </select>
                      </div>

                      {/* Action Buttons */}
                      <div className="flex items-center gap-2 pt-2">
                        <Button variant="primary" onClick={savePersona}>
                          {editingPersona ? "Update" : "Create"} Persona
                        </Button>
                        <Button variant="secondary" onClick={resetForm}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}