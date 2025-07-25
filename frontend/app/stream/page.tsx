'use client';

import { useStreaming } from '@/hooks/useStreaming';
import { useEffect, useRef } from 'react';

export default function StreamPage() {
  const streaming = useStreaming({ role: 'streamer' });
  const localVideoRef = useRef<HTMLVideoElement>(null);

  // Assign the ref from our hook
  useEffect(() => {
    if (localVideoRef.current) {
      streaming.localVideoRef.current = localVideoRef.current;
    }
  }, [streaming.localVideoRef]);

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">Live Stream</h1>
          <div className="flex items-center gap-4">
            <div className={`w-3 h-3 rounded-full ${streaming.isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className="text-sm">{streaming.isConnected ? 'Connected' : 'Disconnected'}</span>
          </div>
        </div>

        {/* Error Display */}
        {streaming.error && (
          <div className="bg-red-900/20 border border-red-500 rounded-lg p-4 mb-6">
            <p className="text-red-300">{streaming.error}</p>
          </div>
        )}

        {/* Main Content */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Local Video */}
          <div className="lg:col-span-2">
            <div className="bg-gray-800 rounded-lg p-4">
              <h2 className="text-xl font-semibold mb-4">Your Stream</h2>
              <div className="relative aspect-video bg-gray-700 rounded-lg overflow-hidden">
                <video
                  ref={localVideoRef}
                  autoPlay
                  muted
                  playsInline
                  className="w-full h-full object-cover"
                />
                {!streaming.streamState.video && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-gray-400">Camera Off</span>
                  </div>
                )}
              </div>

              {/* Controls */}
              <div className="flex justify-center gap-4 mt-4">
                <button
                  onClick={streaming.toggleVideo}
                  className={`px-4 py-2 rounded-lg font-medium ${
                    streaming.streamState.video 
                      ? 'bg-blue-600 hover:bg-blue-700' 
                      : 'bg-red-600 hover:bg-red-700'
                  }`}
                >
                  {streaming.streamState.video ? '📹 Video On' : '📹 Video Off'}
                </button>
                <button
                  onClick={streaming.toggleAudio}
                  className={`px-4 py-2 rounded-lg font-medium ${
                    streaming.streamState.audio 
                      ? 'bg-blue-600 hover:bg-blue-700' 
                      : 'bg-red-600 hover:bg-red-700'
                  }`}
                >
                  {streaming.streamState.audio ? '🎤 Mic On' : '🎤 Mic Off'}
                </button>
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Join/Leave Controls */}
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-lg font-semibold mb-4">Stream Control</h3>
              {!streaming.isJoined ? (
                <button
                  onClick={streaming.joinAsStreamer}
                  disabled={streaming.isLoading}
                  className="w-full bg-green-600 hover:bg-green-700 disabled:bg-gray-600 px-4 py-2 rounded-lg font-medium"
                >
                  {streaming.isLoading ? '🔄 Joining...' : '🚀 Start Streaming'}
                </button>
              ) : (
                <button
                  onClick={streaming.cleanup}
                  className="w-full bg-red-600 hover:bg-red-700 px-4 py-2 rounded-lg font-medium"
                >
                  🛑 Stop Streaming
                </button>
              )}
            </div>

            {/* Remote Peers */}
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-lg font-semibold mb-4">Other Streamers ({streaming.remotePeers.size})</h3>
              <div className="space-y-3">
                {Array.from(streaming.remotePeers.entries()).map(([peerId, peer]) => (
                  <div key={peerId} className="bg-gray-700 rounded-lg p-3">
                    <div className="aspect-video bg-gray-600 rounded overflow-hidden mb-2">
                      <video
                        ref={(el) => {
                          if (el && peer.stream) {
                            el.srcObject = peer.stream;
                            streaming.remoteVideoRefs.current.set(peerId, el);
                          }
                        }}
                        autoPlay
                        playsInline
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <p className="text-sm text-gray-300">Peer: {peerId.slice(0, 8)}...</p>
                  </div>
                ))}
                {streaming.remotePeers.size === 0 && (
                  <p className="text-gray-400 text-sm">No other streamers connected</p>
                )}
              </div>
            </div>

            {/* Stats */}
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-lg font-semibold mb-4">Stream Info</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Status:</span>
                  <span className={streaming.isJoined ? 'text-green-400' : 'text-gray-400'}>
                    {streaming.isJoined ? 'Live' : 'Offline'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Video:</span>
                  <span className={streaming.streamState.video ? 'text-green-400' : 'text-red-400'}>
                    {streaming.streamState.video ? 'On' : 'Off'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Audio:</span>
                  <span className={streaming.streamState.audio ? 'text-green-400' : 'text-red-400'}>
                    {streaming.streamState.audio ? 'On' : 'Off'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Remote Videos Grid */}
        {streaming.remotePeers.size > 0 && (
          <div className="mt-8">
            <h2 className="text-xl font-semibold mb-4">Connected Streamers</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {Array.from(streaming.remotePeers.entries()).map(([peerId, peer]) => (
                <div key={peerId} className="bg-gray-800 rounded-lg p-4">
                  <div className="aspect-video bg-gray-700 rounded overflow-hidden mb-2">
                    <video
                      ref={(el) => {
                        if (el && peer.stream) {
                          el.srcObject = peer.stream;
                        }
                      }}
                      autoPlay
                      playsInline
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <p className="text-sm text-center text-gray-300">Peer: {peerId.slice(0, 12)}...</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}