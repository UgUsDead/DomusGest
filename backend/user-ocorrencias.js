const express = require('express');

module.exports = function(db) {
  const router = express.Router();
  // Get ocorrências for a specific user
  router.get('/api/users/:userId/ocorrencias', (req, res) => {
    const userId = parseInt(req.params.userId);
    if (!userId) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Get all condominiums the user belongs to or works in as maintenance
    const sql = `
      SELECT DISTINCT 
        o.*,
        c.name as condominium_name,
        (
          SELECT json_object(
            'comment', ou.comment,
            'created_at', ou.created_at
          )
          FROM ocorrencia_updates ou 
          WHERE ou.ocorrencia_id = o.id 
          ORDER BY ou.created_at DESC 
          LIMIT 1
        ) as latest_update
      FROM ocorrencias o
      JOIN condominiums c ON o.condominium_id = c.id
      LEFT JOIN user_condominiums uc ON c.id = uc.condominium_id AND uc.user_id = ?
      LEFT JOIN maintenance_workers mw ON o.assigned_maintenance_id = mw.id AND mw.user_id = ?
      WHERE uc.user_id IS NOT NULL OR mw.user_id IS NOT NULL
      ORDER BY o.created_at DESC
      LIMIT 100
    `;

    db.all(sql, [userId, userId], (err, ocorrencias) => {
      if (err) {
        console.error('Error getting user ocorrencias:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      // Parse the latest_update JSON string for each ocorrencia
      const enrichedOcorrencias = ocorrencias.map(o => ({
        ...o,
        latest_update: o.latest_update ? JSON.parse(o.latest_update).comment : null,
        updated_at: o.latest_update ? JSON.parse(o.latest_update).created_at : null
      }));

      res.json(enrichedOcorrencias);
    });
  });

  return router;
};