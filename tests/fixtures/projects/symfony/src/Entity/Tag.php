<?php

namespace App\Entity;

use App\Model\BaseEntity;

// Mapeado por config/doctrine/Tag.orm.xml.
class Tag extends BaseEntity
{
    private ?int $id = null;
    private string $label = '';
}
